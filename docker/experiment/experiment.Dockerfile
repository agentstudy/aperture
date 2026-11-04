# Images for the experiment codespaces (store/library x warmup/main x aperture/baseline).
# Two targets share one base, so the conditions differ only in the tool:
#   --target aperture   Aperture at APERTURE_SHA plus its VS Code extension
#   --target baseline   pristine OpenCode at BASELINE_SHA; no Aperture code in the image
# Nothing repo-specific and no secrets. Versions match what the pilot ran (pilot.sh).
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04 AS base

ARG NODE_VERSION=20.20.2
ARG UV_VERSION=0.11.28
ARG BUN_VERSION=1.3.14
ARG PLAYWRIGHT_VERSION=1.64.1

RUN apt-get update && apt-get install -y --no-install-recommends make g++ python3 xz-utils \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && node --version | grep -qx "v${NODE_VERSION}"
RUN curl -fsSL "https://astral.sh/uv/${UV_VERSION}/install.sh" \
      | env UV_UNMANAGED_INSTALL=/usr/local/bin sh

# bun install compiles tree-sitter native modules. Left alone it fetches node-gyp@latest, which no
# longer runs on Node 20; this is the version in the tools' own bun.lock.
RUN npm install -g node-gyp@12.2.0 && rm -rf /root/.npm

# Outside $HOME/.local/share: the tools run with XDG_DATA_HOME pointed at the session record,
# which would otherwise hide uv's managed Python from anything the agent runs.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN uv python install 3.12 && chmod -R a+rX /opt/uv-python

# Browser system libraries need root; the browser itself goes in vscode's cache below.
RUN npx -y "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm

COPY docker/experiment/bin/ /opt/study/bin/
COPY docker/experiment/opencode.json /opt/study/opencode.json
RUN chmod 0755 /opt/study/bin/* \
    && ln -s /opt/study/bin/study-capture /usr/local/bin/study-capture \
    && ln -s /opt/study/bin/study-verify /usr/local/bin/study-verify \
    && mkdir -p /opt/tool && chown vscode:vscode /opt/tool

USER vscode
RUN npx -y "playwright@${PLAYWRIGHT_VERSION}" install chromium && rm -rf /home/vscode/.npm
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
ENV PATH="/home/vscode/.bun/bin:${PATH}"

# Fetches one commit only, so the baseline image carries no Aperture history.
FROM base AS aperture
ARG APERTURE_SHA
USER root
RUN ln -s /opt/study/bin/study-tool /usr/local/bin/aperture
USER vscode
RUN test -n "${APERTURE_SHA}" \
 && cd /opt/tool && git init -q && git remote add origin https://github.com/aperture-study/aperture \
 && git fetch -q --depth 1 origin "${APERTURE_SHA}" && git checkout -q FETCH_HEAD \
 && bun install \
 && cd sdks/aperture-vscode && bun install && bash package-vsix.sh \
 && cp aperture-0.0.1.vsix /opt/tool/aperture.vsix \
 && printf 'TOOL=aperture\nTOOL_COMMIT=%s\n' "${APERTURE_SHA}" > /opt/tool/tool.env
RUN test -f /opt/tool/aperture.vsix && test -f /opt/tool/packages/opencode/src/aperture/study-log.ts \
 && test -n "$(find /opt/tool/node_modules/.bun -name tree_sitter_powershell_binding.node -print -quit)"

FROM base AS baseline
ARG BASELINE_SHA
USER root
RUN ln -s /opt/study/bin/study-tool /usr/local/bin/opencode
USER vscode
RUN test -n "${BASELINE_SHA}" \
 && cd /opt/tool && git init -q && git remote add origin https://github.com/aperture-study/aperture \
 && git fetch -q --depth 1 origin "${BASELINE_SHA}" && git checkout -q FETCH_HEAD \
 && bun install \
 && printf 'TOOL=opencode\nTOOL_COMMIT=%s\n' "${BASELINE_SHA}" > /opt/tool/tool.env
RUN test ! -e /opt/tool/packages/opencode/src/aperture \
 && test -n "$(find /opt/tool/node_modules/.bun -name tree_sitter_powershell_binding.node -print -quit)"
