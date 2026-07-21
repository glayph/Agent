# Agent CLI package for public npm distribution

This directory contains the CLI agent entry point that serves as the main interface when the Nexus project is distributed via npm. Unlike the system-level packages that are grouped under `packages/` in the monorepo structure, this package is intended to be published and installed as a standalone npm package.

## Overview

The `@hiro/cli` package provides:

1. **Entry Point**: `agent.js` - Main CLI script that launches the Nexus dashboard
2. **CLI Commands**: start, doctor, install, uninstall, version, help
3. **Runtime Support**: Express gateway launching, system tray integration
4. **Platform Detection**: Works on Windows, macOS, and Linux

## Key Features

- **npm Package Integration**: Can be installed via `npm install @hiro/cli`
- **Multiple Platforms**: Works on Windows, macOS, and Linux systems
- **Multiple Interfaces**: 
  - Normal dashboard mode
  - System tray mode (for minimalist operation)
  - Windows installer mode
- **System Diagnostics**: `agent doctor` command for health checks
- **Installation/Uninstallation**: Proper package lifecycle management

## Usage

```bash
# Install the CLI package
npm install @hiro/cli

# Start the dashboard
agent start

# Run diagnostics
agent doctor

# Show version information
agent version

# Show help
agent help
```

## Runtime Requirements

- Node.js: `^20.19.0 || ^22.13.0 || >=24`
- Platform: Windows, macOS, or Linux
- Dependencies: dotenv, express, http-proxy-middleware, ws, zod

## Package Structure

```
@hiro/cli/
├── agent.js           # Main CLI entry point
├── package.json       # Package metadata
└── README.md          # Package documentation
```

## CLI Command Reference

| Command | Description |
|---------|-------------|
| `agent start` | Start the Nexus dashboard and agent runtime |
| `agent doctor` | Run system diagnostics and health checks |
| `agent install` | Install Nexus (npm package mode) |
| `agent uninstall` | Uninstall Nexus from system |
| `agent version` | Show version and build information |
| `agent help` | Show comprehensive help information |

## Flag Support

- `--tray` - Launch in system tray mode (minimal interface)
- `--help` - Show help for specific command

## Environment Variables

- `Hiro_INSTALLER=1` - Indicates running from Windows installer
- `Hiro_NPM_PACKAGE=1` - Indicates running from npm package

## CLI Behavior

The CLI detects the installation context and adapts behavior accordingly:

1. **NPM Package Mode**: Launches the Express gateway dashboard
2. **Windows Installer Mode**: Uses native Hiro.exe wrapper for optimized system integration
3. **System Tray Mode**: Provides minimal interface with system tray integration

## Package Installation

When installed via npm, this package:

1. Creates necessary directories (data, logs, config)
2. Sets up proper environment variables
3. Provides proper CLI entry points
4. Supports both normal and tray-based operation modes

## Integration with Nexus Runtime

This package integrates with the full Nexus runtime stack:

- **Gateway**: Express gateway server
- **Core**: Agent runtime API
- **Memory**: GraphRAG memory system
- **Skills**: Pre-bundled skills library
- **Channels**: 11+ channel adapters (Telegram, Discord, Slack, Matrix, etc.)
- **Dashboard**: React-based management interface
- **Installation**: Skill installation and management system

## Security Considerations

When using this package in production:

- Ensure proper permissions on data and log directories
- Use environment variables for sensitive configuration
- Consider using `agent doctor` for periodic system health checks
- Keep the package updated for security patches

## Package Maintenance

After publishing to npm:

- Run `npm publish` to release updates
- Use `agent doctor` to verify installation health
- Check environment requirements before running
- Monitor package health using npm tools

## Technical Details

The `agent.js` script is a standalone Node.js application that:

- Parses command line arguments
- Detects execution context (npm vs installer)
- Launches the appropriate runtime
- Provides comprehensive error handling
- Offers system tray integration for minimalism

This package enables users to easily install and run the Nexus AI agent platform via npm, making it accessible to both developers and end users without complex installation procedures.
