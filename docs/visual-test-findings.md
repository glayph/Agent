# Visual Test Findings

The integrated Agent Miki runtime was started locally and reached a healthy gateway state. The dashboard setup screen rendered with the single dark visual theme and accepted the configured eight-character password. The sign-in screen accepted the same password and redirected to the authenticated dashboard.

The Models page rendered successfully and displayed the Gemini provider cards, the local llama.cpp provider card, model status controls, the voice configuration entry, and the expected warning that no provider credential is configured in the test environment. The Chat workspace also rendered successfully with the navigation rail, workspace status, model-configuration guidance, goal action, and message composer.

A frontend-only Vite session without the integrated backend produced expected 502 session-history errors and a blank application state. This is an environment limitation of running the static frontend alone, not a production runtime failure. The integrated runtime resolved the issue and served the UI correctly through the gateway.
