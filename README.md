# Snapbot

Repeatable screenshots of Expo iOS apps, captured locally with a CLI and the
`react-native-snapbot` support package. Open routes and app states, wait for
pixels to settle, and save PNGs with a machine-readable run summary.

**[Read the documentation](https://twocentinc.github.io/oss/docs/snapbot/)**

- [Installation and first capture](https://twocentinc.github.io/oss/docs/snapbot/getting-started/)
- [Expo app integration](https://twocentinc.github.io/oss/docs/snapbot/app-integration/)
- [Modals, sheets, and app states](https://twocentinc.github.io/oss/docs/snapbot/app-states/)
- [Configuration](https://twocentinc.github.io/oss/docs/snapbot/configuration/)
- [CLI, output, and failure behavior](https://twocentinc.github.io/oss/docs/snapbot/cli-and-output/)
- [Automation](https://twocentinc.github.io/oss/docs/snapbot/automation/)
- [Security](https://twocentinc.github.io/oss/docs/snapbot/security/)
- [Troubleshooting](https://twocentinc.github.io/oss/docs/snapbot/troubleshooting/)
- [Development and tests](https://twocentinc.github.io/oss/docs/snapbot/contributing/)

Capture requires macOS, Xcode, an installed iOS Simulator runtime, Node.js 22+,
CocoaPods, and an Expo app with a development client. Packages are currently
installed from source; follow the installation guide rather than bare npm names.

Visual stability is not a semantic assertion that the intended screen appeared.
Timeouts can produce warnings with exit zero; inspect the summary and PNGs.

Detailed documentation is maintained in the shared twocents docs site. This
repository owns the implementation, runtime configuration validator, and tests.
