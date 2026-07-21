module github.com/sipeed/Hiro/web/backend

go 1.26.2

// NOTE: This go.mod only covers the stub backend (stub_main.go).
// The legacy full backend (main.go, api/models.go, etc.) requires
// additional dependencies from github.com/sipeed/Hiro/pkg/* that
// are not vendored here. To build the legacy backend, you need the
// complete Go module workspace with all transitive dependencies.
