# @better-forge/mirror

Publishes a set of files to static hosting.

- `createS3Transport`: uploads to S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO) with a SigV4
  signature over `fetch`; no SDK.
- `createMirrorPublisher`: uploads files in the given order, skipping those whose content did not change since the
  last successful upload, with a timeout per request.
- `createIntervalRunner`: runs a job every interval, never two at once.

Depends on: nothing.
