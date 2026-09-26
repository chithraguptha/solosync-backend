export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "SoloSync API",
    version: "1.0.0",
    description: "Developer API for WhatsApp messaging, connection management, account information and usage.",
  },
  servers: [{ url: "https://api.solosync.live", description: "Production" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "SoloSync API key" },
    },
    schemas: {
      Message: {
        type: "object",
        properties: {
          id: { type: "string", example: "publication_id" },
          chatId: { type: "string", example: "919876543210@c.us" },
          kind: { type: "string", enum: ["text", "image", "video"] },
          text: { type: "string", example: "Hello from SoloSync" },
          status: { type: "string", enum: ["queued", "publishing", "published", "failed"] },
          deliveryStatus: { type: "string", enum: ["UNKNOWN", "PENDING", "SERVER", "DEVICE", "READ", "PLAYED", "ERROR"] },
          providerMessageId: { type: "string", nullable: true },
          error: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          publishedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
    },
  },
  paths: {
    "/v1/account": {
      get: {
        summary: "Get account information",
        tags: ["Account"],
        responses: { "200": { description: "Account information" }, "401": { description: "Invalid API key" }, "403": { description: "Missing scope" } },
      },
    },
    "/v1/usage": {
      get: {
        summary: "Get the last 30 days of message usage",
        tags: ["Account"],
        responses: { "200": { description: "Usage totals" }, "401": { description: "Invalid API key" } },
      },
    },
    "/v1/connection": {
      get: {
        summary: "Get WhatsApp connection status",
        tags: ["Connection"],
        responses: { "200": { description: "Connection status" }, "401": { description: "Invalid API key" } },
      },
      post: {
        summary: "Establish or resume the WhatsApp connection",
        tags: ["Connection"],
        responses: { "200": { description: "Connection and optional QR payload" }, "402": { description: "Activation required" }, "401": { description: "Invalid API key" } },
      },
    },
    "/v1/connection/qr": {
      get: {
        summary: "Get the current pairing QR payload",
        tags: ["Connection"],
        responses: { "200": { description: "QR image payload" }, "404": { description: "No connection exists" }, "401": { description: "Invalid API key" } },
      },
    },
    "/v1/messages": {
      get: {
        summary: "List message history",
        tags: ["Messages"],
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
        ],
        responses: {
          "200": {
            description: "Paginated message history",
            content: { "application/json": { schema: { type: "object", properties: { messages: { type: "array", items: { $ref: "#/components/schemas/Message" } }, page: { type: "integer" }, limit: { type: "integer" }, total: { type: "integer" }, pages: { type: "integer" } } } } },
          },
          "401": { description: "Invalid API key" },
        },
      },
      post: {
        summary: "Queue a WhatsApp message",
        tags: ["Messages"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["chatId"],
                properties: {
                  chatId: { type: "string", example: "919876543210" },
                  text: { type: "string", example: "Hello from SoloSync" },
                  kind: { type: "string", enum: ["text", "image", "video"], default: "text" },
                  mediaUrl: { type: "string", format: "uri", nullable: true, example: "https://cdn.example.com/photo.jpg" },
                },
              },
              examples: { text: { value: { chatId: "919876543210", text: "Hello from SoloSync" } } },
            },
          },
        },
        responses: {
          "202": { description: "Message queued" },
          "402": { description: "Insufficient wallet balance" },
          "409": { description: "WhatsApp is not connected or ready" },
          "401": { description: "Invalid API key" },
        },
      },
    },
  },
} as const;
