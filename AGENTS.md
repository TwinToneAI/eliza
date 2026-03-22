# Agent Guidelines

## Review Guidelines

- ALWAYS flag hardcoded secrets, credentials, or API keys
- ALWAYS flag code that calls paid APIs without timeouts, usage limits, or stop mechanisms
- ALWAYS flag missing error handling on external API calls
- ALWAYS flag resource leaks (unclosed connections, sessions, handles)
- Prefer immutable data patterns — flag in-place mutations of shared state
