#!/usr/bin/env bash
set -e


IMG_REG=${IMG_REG:-localhost:5000}
TAG=${TAG:-dev}


# build images
docker build -t ${IMG_REG}/jupyter-singleuser:${TAG} -f docker/Dockerfile.jupyter .
docker build -t ${IMG_REG}/jupyter-api:${TAG} -f docker/Dockerfile.api ./server
docker build -t ${IMG_REG}/jupyter-frontend:${TAG} -f docker/Dockerfile.frontend ./frontend


# push (if using registry)
docker push ${IMG_REG}/jupyter-singleuser:${TAG}
docker push ${IMG_REG}/jupyter-api:${TAG}
docker push ${IMG_REG}/jupyter-frontend:${TAG}