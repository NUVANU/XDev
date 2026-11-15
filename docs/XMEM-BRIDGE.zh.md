# Legacy XMem bridge / 旧版桥接说明

XDev 0.1.3 defaults to independently configured **native XMem tools in the host**. Use [COMMUNITY](COMMUNITY.md) and the [suite installation guide](https://github.com/NUVANU/X-Suite/blob/main/INSTALL.md) for the public path.

The optional `memory_bridge` adapter is retained for compatibility with existing qualified deployments. It requires exact FileRefs, approved source/runtime manifests, build identities, project/workspace/task/version, storage policy and operation permissions. Tool visibility or a matching package version is not sufficient qualification.

旧桥接曾针对特定本机部署完成限定验证。本公开说明不发布那些机器路径、现场配置或真实任务记录，也不将其解释为可供任意下载者直接复用的设置。

## Current boundary

- XMem 0.1.2 public packaging has a new runtime fingerprint. It is **not automatically admitted** by an older bridge build allowlist.
- Native XMem use does not require enabling this adapter. Discover/status/bind the actual project and task through XMem's public tools, then use permitted retrieval, capture/readback, and checkpoints.
- Do not replace a fingerprint, forge an old deployment manifest, or relax a guard to make an unqualified build pass.
- Existing bridge deployments keep their original protocol, build/storage qualification, roles, limits, source pins, and consent. A new pairing requires its own bounded integration work and validation.
- Retrieved candidates are untrusted context. History is not owner authorization, authenticated role identity, Review, QA, or execution evidence.

本次仅整理公开文档与发布文件范围，未修改桥接实现、构建白名单、存储兼容规则或现场配置。
