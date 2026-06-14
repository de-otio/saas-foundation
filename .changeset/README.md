# Changesets

This directory is managed by [changesets](https://github.com/changesets/changesets).

## Workflow

1. Run `npm run changeset` after making a change that affects a published package.
2. Select the affected packages and the semver bump level.
3. Write a one-line summary — this becomes the CHANGELOG entry.
4. Commit the generated `.changeset/<name>.md` file with your PR.

The changesets GitHub Action will consume these files and open a
"Version Packages" PR that bumps versions and updates CHANGELOGs.

For more information, see the [changesets documentation](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md)
and [doc/05-versioning-and-releases.md](../doc/05-versioning-and-releases.md).
