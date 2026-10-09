# The container engine, found once for every script that runs containers (the
# test suites, the operator scripts, deploy/setup.sh). Sourced, not run: sets
# $engine, or exits the script that sourced it, saying what is missing and how
# to fix it.
#
# CONTAINER_ENGINE picks one explicitly (CI uses docker); otherwise podman,
# then docker. Having the binary isn't enough: the docker CLI with its daemon
# stopped, or run by someone outside the docker group, fails every later
# command with a message that doesn't say so, and a suite then dies with an
# empty log. So it is asked to list containers once, here.

engine_fail() { echo "${0##*/}: $*" >&2; exit 1; }

if [ -n "${CONTAINER_ENGINE:-}" ]; then
  engine=$(command -v "$CONTAINER_ENGINE" || true)
  [ -n "$engine" ] || engine_fail "CONTAINER_ENGINE=$CONTAINER_ENGINE is not installed or not on PATH. Install it, or unset CONTAINER_ENGINE to use podman or docker."
else
  engine=$(command -v podman || command -v docker || true)
  [ -n "$engine" ] || engine_fail "needs podman or docker to run containers, and neither is on PATH. Install one (https://podman.io/docs/installation or https://docs.docker.com/engine/install/) and run this again."
fi
engine_err=$("$engine" ps -q 2>&1 >/dev/null) ||
  engine_fail "$engine is installed but can't run containers: \`${engine##*/} ps\` failed with \"${engine_err%%$'\n'*}\". Fix that (docker: start its daemon, or add yourself to the docker group) and run this again."
unset engine_err
unset -f engine_fail
