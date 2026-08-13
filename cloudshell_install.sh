#! /bin/bash
#
# NPK CloudShell bootstrap.
#
#   source <(curl -sL https://raw.githubusercontent.com/0x48756773/npk/main/cloudshell_install.sh)
#
# Optional overrides — export these before sourcing:
#
#   NPK_REPO          owner/name of the GitHub repo to deploy   (default: 0x48756773/npk)
#   NPK_BRANCH        branch to check out                       (default: main)
#   NPK_DIR           working directory                         (default: /aws/mde/npk)
#   NPK_SKIP_DEPLOY   set to anything to prepare the environment without deploying
#
# NOTE: this script is *sourced*, not executed, so it must never call 'exit' or use
# 'set -e' — either would take the user's shell down with it. Failures 'return' instead.

NPK_REPO="${NPK_REPO:-0x48756773/npk}"
NPK_BRANCH="${NPK_BRANCH:-main}"
NPK_DIR="${NPK_DIR:-/aws/mde/npk}"
NPK_REPO_URL="https://github.com/${NPK_REPO}.git"

NODE_VERSION=20.19.2

# These are consumed by child processes — terraform is spawned by node, which is spawned
# here — so they have to be exported. They were previously plain shell variables, which
# meant the parallelism limit and the heap ceiling were silently never applied.
export TF_CLI_ARGS_apply="-parallelism=1"
export NODE_OPTIONS="--max-old-space-size=1536"

if [[ $UID -eq 0 ]]; then
	echo "[!] Don't run this as root."
	return 1
fi

echo "[*] Deploying ${NPK_REPO} @ ${NPK_BRANCH} into ${NPK_DIR}"

# install compiler and cmake3, aliased to cmake
if [[ ! -f /usr/bin/cmake ]]; then
	echo "[*] Installing CMake3, C++"

	if ! sudo yum install -y cmake3 gcc-c++ > /dev/null; then
		echo "[!] Failed to install build prerequisites."
		return 1
	fi

	sudo ln -sf /usr/bin/cmake3 /usr/bin/cmake
fi

# install nvm and node
if [[ ! -d /aws/mde/nvm ]]; then
	echo "[*] Installing NVM"
	sudo mkdir -p /aws/mde/nvm
	sudo chown "$(id -un):$(id -gn)" /aws/mde/nvm

	[[ -e ~/.nvm ]] || ln -s /aws/mde/nvm ~/.nvm

	curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash > /dev/null
fi

export NVM_DIR="/aws/mde/nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

echo "[*] Installing node.js ${NODE_VERSION}"
nvm install $NODE_VERSION > /dev/null
nvm alias default $NODE_VERSION > /dev/null
nvm use $NODE_VERSION > /dev/null

if ! command -v node > /dev/null; then
	echo "[!] node is not on PATH after installing it. Check the nvm output above."
	return 1
fi

# Set up the larger storage environment:
if [[ ! -d "${NPK_DIR}" ]]; then
	sudo mkdir -p "${NPK_DIR}"
	sudo chown "$(id -un):$(id -gn)" "${NPK_DIR}"
fi

if [[ ! -d "${NPK_DIR}/.git" ]]; then
	echo "[*] Cloning ${NPK_REPO} (${NPK_BRANCH})"

	if ! git clone --branch "${NPK_BRANCH}" "${NPK_REPO_URL}" "${NPK_DIR}"; then
		echo "[!] Failed to clone ${NPK_REPO_URL}"
		return 1
	fi
else
	current_remote="$(git -C "${NPK_DIR}" remote get-url origin 2>/dev/null)"

	if [[ "${current_remote}" != "${NPK_REPO_URL}" ]]; then
		echo "[*] Re-pointing existing clone from ${current_remote} to ${NPK_REPO_URL}"
		git -C "${NPK_DIR}" remote set-url origin "${NPK_REPO_URL}"
	fi

	echo "[*] Updating ${NPK_REPO} (${NPK_BRANCH})"

	if ! git -C "${NPK_DIR}" fetch origin --prune; then
		echo "[!] Unable to fetch from ${NPK_REPO_URL}"
		return 1
	fi

	if ! git -C "${NPK_DIR}" checkout "${NPK_BRANCH}"; then
		echo "[!] Unable to check out ${NPK_BRANCH}. Resolve it in ${NPK_DIR}, then re-run."
		return 1
	fi

	# Fast-forward only, deliberately. A hard reset here would silently discard local
	# edits to tracked files. npk-settings.json is gitignored, so it always survives.
	if ! git -C "${NPK_DIR}" merge --ff-only "origin/${NPK_BRANCH}"; then
		echo "[!] ${NPK_DIR} has diverged from origin/${NPK_BRANCH} and can't fast-forward."
		echo "    Resolve it by hand, or move that directory aside and re-run for a fresh clone."
		return 1
	fi
fi

cd "${NPK_DIR}" || return 1

echo
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
echo "[+] Installing Node.js prerequisites. This can take up to two minutes, and may appear frozen. DON'T INTERRUPT IT."
echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
echo
echo

export INIT_CWD="$PWD"

if ! npm install > /dev/null; then
	echo "[!] npm install failed. Not deploying — fix the errors above and re-run."
	return 1
fi

if [[ -n "${NPK_SKIP_DEPLOY}" ]]; then
	echo "[*] NPK_SKIP_DEPLOY is set. Environment is ready; run 'npm run deploy' when you are."
else
	# The discovery phase queries Spot and On-Demand service quotas plus On-Demand pricing
	# across every enabled region, so there's a few minutes of quiet before Terraform runs.
	echo "[*] Deploying. NPK first inventories quotas, instance availability and On-Demand"
	echo "    pricing across all enabled regions, so expect a pause before Terraform starts."
	echo

	bash -c "exec node bin/index.js deploy -y < /dev/tty"
fi

cd "${NPK_DIR}"
export PS1="\e[1m\e[32m@c6fc/npk>\e[0m "
return 0
