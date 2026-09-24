#!/usr/bin/env bash
# Gives the app roles (reliquary_web, reliquary_mcp) login passwords on the
# hosted project, without anyone seeing them:
# - generates a random password per role into supabase/.<role>-password
#   (mode 600, gitignored) for the Vercel env vars, unless the file exists;
# - sends Postgres only a SCRAM-SHA-256 verifier computed here, so the
#   plain password never reaches the server or its logs;
# - checks each role can log in through the transaction pooler.
# Uses supabase/.db-password (the postgres password) for the ALTER ROLE.
set -euo pipefail
cd "$(dirname "$0")/.."

ref=${SUPABASE_PROJECT_REF:-bigonndpibguxuwtysnx}
host=${SUPABASE_POOLER_HOST:-aws-0-eu-central-1.pooler.supabase.com}
engine=${CONTAINER_ENGINE:-$(command -v podman || command -v docker)}
[[ -s supabase/.db-password ]] || { echo "Missing supabase/.db-password."; exit 1; }

"$engine" run --rm --network host -v "$PWD":/app:Z -w /app \
  -e REF="$ref" -e HOST="$host" docker.io/library/postgres:17 bash -c '
set -euo pipefail
apt-get -qq update >/dev/null && apt-get -qq install -y nodejs >/dev/null 2>&1
umask 077
verifier() {
  node -e "
    const c = require(\"crypto\");
    const pw = require(\"fs\").readFileSync(process.argv[1], \"utf8\").trim();
    const salt = c.randomBytes(16), it = 4096;
    const salted = c.pbkdf2Sync(pw.normalize(\"NFKC\"), salt, it, 32, \"sha256\");
    const hmac = (k, s) => c.createHmac(\"sha256\", k).update(s).digest();
    const stored = c.createHash(\"sha256\").update(hmac(salted, \"Client Key\")).digest();
    const server = hmac(salted, \"Server Key\");
    process.stdout.write(\"SCRAM-SHA-256\$\" + it + \":\" + salt.toString(\"base64\") + \"\$\" +
      stored.toString(\"base64\") + \":\" + server.toString(\"base64\"));
  " "$1"
}
export PGPASSWORD=$(tr -d "[:space:]" < supabase/.db-password)
for role in reliquary_web reliquary_mcp; do
  f=supabase/.${role#reliquary_}-db-password
  [[ -s $f ]] || node -e "process.stdout.write(require(\"crypto\").randomBytes(24).toString(\"base64url\"))" > "$f"
  chmod 600 "$f"
  v=$(verifier "$f")
  echo "alter role :\"role\" login password :'"'"'v'"'"';" | psql -q \
    "host=$HOST port=5432 dbname=postgres user=postgres.$REF sslmode=require" \
    -v ON_ERROR_STOP=1 -v role="$role" -v v="$v" >/dev/null
  got=$(PGPASSWORD=$(cat "$f") psql -At "host=$HOST port=6543 dbname=postgres user=$role.$REF sslmode=require" -c "select current_user")
  echo "$role: login ok ($got), password in $f"
done
'
