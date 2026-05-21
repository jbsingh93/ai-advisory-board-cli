@echo off
REM Windows shim that delegates to the Node-based mock claude.
node "%~dp0..\mock-claude.mjs" %*
