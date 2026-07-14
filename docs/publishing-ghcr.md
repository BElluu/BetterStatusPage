# Publishing a new release to GHCR

Releases are published manually with `scripts/publish-release.ps1`. The script automates:

- synchronizing the version across all npm workspaces and `package-lock.json`;
- updating the `ghcr.io/belluu/better-status-page` image tag in `README.md` and `docs/*.md` files;
- linting, testing, building, and checking version consistency;
- creating a `chore: release X.Y.Z` commit;
- building one Linux AMD64 image with the `X.Y.Z` and `latest` tags;
- logging in to GHCR, publishing both tags, and logging out;
- creating and publishing the `vX.Y.Z` Git tag.

## Requirements

- the current branch must be `main`;
- the working tree must be clean;
- Docker Desktop must be running in Linux containers mode;
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

- the version does not follow the `X.Y.Z` format;
- the current branch is not `main`;
- the working tree contains uncommitted or untracked files;
- the requested version is lower than the current version;
- the `vX.Y.Z` tag already exists locally or on GitHub;
- workspace or lockfile versions are inconsistent;
- linting, tests, or the build fail;
- the two local image tags do not point to the same image;
- publishing the versioned image fails.

The `latest` tag is published only after the versioned image has been pushed successfully.

If the script stops after creating the local release commit, it does not remove or reset changes automatically. Check `git status`, the log, and the error message before trying again.
