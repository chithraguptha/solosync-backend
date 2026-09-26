export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "SoloSync API",
    version: "1.0.0",
    description: "Developer API for WhatsApp messaging, account information and connection management.",
  },
  servers: [{ url: "https://api.solosync.live", description: "Production" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "SoloSync API key" },
    },
  },
  paths: {
    "/v1/account": {
      get: {
        summary: "Get account information",
        tags: ["Account"],
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Account information" }, "401": { description: "Invalid API key" } },
      },
    },
    "/v1/connection": {
      get: {
        summary: "Get WhatsApp connection status",
        tags: ["Connection"],
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Connection status" }, "401": { description: "Invalid API key" } },
      },
      post: {
        summary: "Establish or start the WhatsApp connection",
        tags: ["Connection"],
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Connection and QR state" }, "402": { description: "Activation required" } },
      },
    },
    "/v1/messages": {
      get: {
        summary: "List messages",
        tags: ["Messages"],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
        ],
        responses: { "200": { description: "Message history" } },
      },
      post: {
        summary: "Send a WhatsApp message",
        tags: ["Messages"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["chatId", "text"],
                properties: {
                  chatId: { type: "string", example: "919876543210" },
                  text: { type: "string", example: "Hello from SoloSync" },
                  kind: { type: "string", enum: ["text", "image", "video"], default: "text" },
                  mediaUrl: { type: "string", format: "uri", nullable: true },
                },
              },
            },
          },
        },
        responses: { "202": { description: "Message queued" }, "402": { description: "Insufficient wallet balance" } },
      },
    },
  },
} as const;
