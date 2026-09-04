export interface GatewayConfig {
  corePort: number;
  gatewayPort: number;
  isHeadless: boolean;
  workspaceDir: string;
}

export interface HealthResponse {
  status: string;
  service: string;
}
