#!/usr/bin/env bash
# Gives the app roles login passwords on the hosted project, without anyone
# seeing them:
#
#   scripts/set-role-passwords.sh          reliquary_web and reliquary_mcp
#   scripts/set-role-passwords.sh ops      reliquary_ops, the operator's role
#                                          for re-encrypting variables
#                                          (scripts/rotate-variables-key.sh)
#   scripts/set-role-passwords.sh ops-off  reliquary_ops back to nologin, with
#                                          no password, and its file removed
#
# - generates a random password per role into supabase/.<role>-db-password
#   (mode 600, gitignored) for the Vercel env vars or the rotation script,
#   unless the file exists;
# - sends Postgres only a SCRAM-SHA-256 verifier computed here, so the
#   plain password never reaches the server or its logs;
# - checks each role can log in through the transaction pooler.
# Never prints a password. Uses supabase/.db-password (the postgres
# password) for the ALTER ROLE.
set -euo pipefail
cd "$(dirname "$0")/.."

case ${1:-} in
  "") roles="reliquary_web reliquary_mcp" ;;
  ops) roles="reliquary_ops" ;;
  ops-off) roles="" ;;
  *) echo "usage: scripts/set-role-passwords.sh [ops | ops-off]"; exit 2 ;;
esac

source scripts/lib/supabase-env.sh
source scripts/lib/engine.sh
[[ -s supabase/.db-password ]] || { echo "Missing supabase/.db-password."; exit 1; }

if [[ ${1:-} == ops-off ]]; then
  "$engine" run --rm --network host -v "$PWD":/app:Z -w /app \
    -e REF="$ref" -e HOST="$host" docker.io/library/postgres:17 bash -c '
set -euo pipefail
export PGPASSWORD=$(tr -d "[:space:]" < supabase/.db-password)
echo "alter role reliquary_ops nologin password null;" | psql -q \
  "host=$HOST port=5432 dbname=postgres user=postgres.$REF sslmode=require" -v ON_ERROR_STOP=1 >/dev/null
'
  rm -f supabase/.ops-db-password
  echo "reliquary_ops: nologin, no password; supabase/.ops-db-password removed"
  exit 0
fi

"$engine" run --rm --network host -v "$PWD":/app:Z -w /app \
  -e REF="$ref" -e HOST="$host" -e ROLES="$roles" docker.io/library/postgres:17 bash -c '
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
for role in $ROLES; do
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
