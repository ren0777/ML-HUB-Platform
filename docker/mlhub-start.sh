#!/bin/bash
set -euo pipefail

NOTEBOOK_PORT="${NOTEBOOK_PORT:-8888}"
NOTEBOOK_BASE_URL="${NOTEBOOK_BASE_URL:-/jupyter}"
NOTEBOOK_ROOT_DIR="${NOTEBOOK_ROOT_DIR:-/home/jovyan/work}"

mkdir -p "$NOTEBOOK_ROOT_DIR" /home/jovyan/.local /home/jovyan/.cache
chown -R 1000:100 /home/jovyan

cmd=(
  /opt/conda/bin/jupyter
  lab
  --ip=0.0.0.0
  "--port=${NOTEBOOK_PORT}"
  "--ServerApp.base_url=${NOTEBOOK_BASE_URL}"
  "--ServerApp.root_dir=${NOTEBOOK_ROOT_DIR}"
  --ServerApp.allow_origin=*
  --ServerApp.disable_check_xsrf=True
  --ServerApp.token=
  --IdentityProvider.token=
  --PasswordIdentityProvider.hashed_password=
  "--ServerApp.tornado_settings={\"headers\":{\"Content-Security-Policy\":\"frame-ancestors * 'self'\"}}"
)

exec su -s /bin/bash jovyan -c "$(printf '%q ' "${cmd[@]}")"