FROM node:24-slim

# go-task runner — pinned version for reproducible builds
ARG TASK_VERSION=v3.40.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d -b /usr/local/bin ${TASK_VERSION} \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

CMD ["bash"]
