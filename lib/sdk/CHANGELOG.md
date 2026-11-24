# Changelog

All notable changes to `@streampay/sdk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-22

### Added

- Initial packaged release of the partner SDK, built from `lib/sdk` with ESM
  output and generated type declarations.
- `createStreamPayClient` and the `StreamPayClient` REST helpers:
  `listStreams`, `getStream`, `createStream`, `deleteStream`, and
  `listActivity`.
- `subscribeToStream` for the live stream events protocol, with shared
  `EventSource` connections and injectable `eventSourceFactory`.
- `StreamPaySdkError` with redacted `details`, plus `SdkErrorCode`,
  `StreamStatus`, `StreamPayStream`, and the supporting request/response types.
- `exports` map for `@streampay/sdk` and `@streampay/sdk/types`.

## Versioning policy

While the package is pre-1.0, minor versions may include breaking changes, but
they are always called out in this changelog. From 1.0.0 onward the following
rules apply.

Breaking changes (major version):

- Removing or renaming an exported value, type, or subpath export.
- Changing an exported function or method signature, including adding a
  required option or removing an optional one.
- Changing the shape of a returned object in a way existing callers cannot
  ignore.
- Raising the minimum supported Node.js version.

Non-breaking changes (minor or patch version):

- Adding new exports, methods, or optional options and fields.
- Bug fixes and internal refactors that keep the public API unchanged.
- Documentation, type-only improvements, and dependency updates that do not
  change behaviour.
