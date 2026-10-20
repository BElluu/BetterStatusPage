# Publishing a new release to GHCR

Releases are published manually with `scripts/publish-release.ps1`. The script automates:

- synchronizing the version across all npm workspaces and `package-lock.json`;
- updating the `ghcr.io/belluu/better-status-page` image tag in `README.md`, `README.pl.md` and `docs/*.md` files;
- removing the `> [!WARNING]` / `> **Not released yet.**` callouts from `README.md`, `README.pl.md` and `docs/*.md`, because everything on `main` ships with the release;
- turning the `## [Unreleased]` heading in `docs/changelog.md` into `## [X.Y.Z] - YYYY-MM-DD` (today's date) and leaving a fresh empty `## [Unreleased]` above it;
- auditing production dependencies, linting, testing, building, and checking version consistency;
- creating a `chore: release X.Y.Z` commit;
- logging in to GHCR;
- building and pushing one multi-platform image (`linux/amd64` and `linux/arm64`) as `X.Y.Z`, then pointing `latest` at the same manifest, and logging out;
- creating and publishing the `vX.Y.Z` Git tag.

## Requirements

- the current branch must be `main`;
- the working tree must be clean;
- Docker Desktop must be running in Linux containers mode with the containerd image store enabled (Settings → General → "Use containerd for pulling and storing images"), which `docker buildx build` needs for multi-platform builds with the default builder. The arm64 half is built under QEMU emulation, so expect the build to take noticeably longer;
- a GitHub classic PAT with the `write:packages` scope;
- permission to push to the repository and the `ghcr.io/belluu/better-status-page` package.

## Usage

Run the following command from the repository root:

```powershell
.\scripts\publish-release.ps1 -Version 0.1.2
```

The script prompts for the PAT without displaying it:

```text
GitHub PAT classic with write:packages: ********
```

The version number and PAT are the only required inputs. The token is not stored in the repository or command history.

You can also provide the PAT as a `SecureString`:

```powershell
$pat = Read-Host 'GitHub PAT classic with write:packages' -AsSecureString
.\scripts\publish-release.ps1 -Version 0.1.2 -GitHubPat $pat
```

## Safety checks

The script stops the release if:

- the version does not follow the `X.Y.Z` format (a leading `v`, as in `v0.1.2`, is accepted; it is stripped from the package versions, changelog and image tag, while the Git tag is always `vX.Y.Z`);
- the current branch is not `main`;
- the working tree contains uncommitted or untracked files;
- the requested version is lower than the current version;
- the `vX.Y.Z` tag already exists locally or on GitHub;
- workspace or lockfile versions are inconsistent;
- linting, tests, or the build fail;
- building or publishing the versioned image fails.

The `latest` tag is published only after the versioned image has been pushed successfully, and it is a copy of the same manifest list, so both tags always contain identical images.

If the script stops after creating the local release commit, it does not remove or reset changes automatically. Check `git status`, the log, and the error message before trying again.
