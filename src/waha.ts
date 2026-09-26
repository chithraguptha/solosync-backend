import crypto from "crypto";

export type WahaConfig = {
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs?: number;
  webhookUrl?: string;
  webhookHmacKey?: string;
};

export class WahaClient {
  constructor(private readonly config: WahaConfig) {}

  private async request(path: string, init: RequestInit = {}) {
    const controller = new AbortController();
    const timeoutMs = Math.max(1000, this.config.requestTimeoutMs || 30000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(this.config.baseUrl.replace(/\/$/, "") + path, {
        ...init,
        signal: controller.signal,
        headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Api-Key": this.config.apiKey,
        ...(init.headers || {}),
      },
    });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`WAHA ${response.status}: ${body.slice(0, 500)}`);
      }

      const contentType = response.headers.get("content-type") || "";
      return contentType.includes("application/json")
        ? response.json()
        : response;
    } catch (error: any) {
      if (error?.name === "AbortError") {
        throw new Error(`WAHA request timed out after ${timeoutMs}ms: ${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async createSession(name: string) {
    return this.request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        name,
        config: {
          webhooks: this.config.webhookUrl
            ? [{
                url: this.config.webhookUrl,
                events: ["session.status", "message.any", "message.ack"],
                ...(this.config.webhookHmacKey
                  ? { hmac: { key: this.config.webhookHmacKey } }
                  : {}),
              }]
            : [],
        },
      }),
    });
  }

  async startSession(name: string) {
    return this.request(`/api/sessions/${encodeURIComponent(name)}/start`, { method: "POST" });
  }
  async stopSession(name: string) {
    return this.request(
      `/api/sessions/${encodeURIComponent(name)}/stop`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }


  async updateSessionWebhooks(name: string) {
    if (!this.config.webhookUrl) return;
    return this.request(`/api/sessions/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({
        name,
        config: {
          webhooks: [{
            url: this.config.webhookUrl,
            events: ["session.status", "message.any", "message.ack"],
            ...(this.config.webhookHmacKey ? { hmac: { key: this.config.webhookHmacKey } } : {}),
          }],
        },
      }),
    });
  }
  async getSession(name: string) {
    return this.request(`/api/sessions/${encodeURIComponent(name)}`);
  }

  async getMe(name: string) {
    return this.request(`/api/sessions/${encodeURIComponent(name)}/me`);
  }

  async getQr(name: string) {
    return this.request(`/api/${encodeURIComponent(name)}/auth/qr?format=image`, { method: "GET", headers: { Accept: "application/json" } });
  }

  async getChannels(name: string) {
    return this.request(`/api/${encodeURIComponent(name)}/channels`);
  }

  async getChatMessages(session: string, chatId: string, limit = 100) {
    return this.request(
      `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages?limit=${Math.min(100, Math.max(1, limit))}&downloadMedia=false`,
    );
  }
  async resolveChatId(session: string, chatId: string) {
    const value = String(chatId || "").trim();
    if (!value) throw new Error("Recipient is required");

    // Groups, channels and already-resolved LIDs must be passed through unchanged.
    if (value.endsWith("@g.us") || value.endsWith("@newsletter") || value.endsWith("@lid")) return value;

    // WAHA/WhatsApp can migrate a contact from @c.us to @lid. Resolve the
    // current chat id immediately before sending instead of guessing it.
    const phone = value.replace(/^\+/, "").replace(/@c\.us$/, "").replace(/\D/g, "");
    if (!phone) throw new Error("Recipient must be a WhatsApp phone number or chat ID");

    const result: any = await this.request(
      `/api/contacts/check-exists?phone=${encodeURIComponent(phone)}&session=${encodeURIComponent(session)}`,
      { method: "GET" },
    );

    if (!result?.numberExists || !result?.chatId) {
      throw new Error("The recipient number is not registered on WhatsApp");
    }

    return String(result.chatId);
  }

  async sendText(session: string, chatId: string, text: string) {
    return this.request("/api/sendText", {
      method: "POST",
      body: JSON.stringify({ session, chatId, text }),
    });
  }

  async sendImage(session: string, chatId: string, url: string, caption?: string) {
    return this.request("/api/sendImage", {
      method: "POST",
      body: JSON.stringify({
        session,
        chatId,
        file: { url, mimetype: "image/jpeg", filename: "solosync-image.jpg" },
        ...(caption ? { caption } : {}),
      }),
    });
  }

  async sendVideo(session: string, chatId: string, url: string, caption?: string) {
    return this.request("/api/sendVideo", {
      method: "POST",
      body: JSON.stringify({
        session,
        chatId,
        file: { url, mimetype: "video/mp4", filename: "solosync-video.mp4" },
        ...(caption ? { caption } : {}),
      }),
    });
  }

  verifyWebhook(rawBody: string, signature?: string) {
    if (!this.config.webhookHmacKey || !signature) return true;
    const digest = crypto
      .createHmac("sha512", this.config.webhookHmacKey)
      .update(rawBody)
      .digest("hex");
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  }
}
