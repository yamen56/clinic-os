/**
 * Minimal stand-in for the Anthropic Messages API, used by qa-phase8 so the
 * agent's real code path (tool runner → tool execution → DB writes) can be
 * exercised without live API credentials.
 *
 * Scripts responses by inspecting the last user message.
 */
import http from "node:http";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

let callCount = 0;

function scriptResponse(body: {
  messages: { role: string; content: unknown }[];
  system?: string;
}): { content: Block[]; stop_reason: string } {
  const msgs = body.messages;
  const last = msgs[msgs.length - 1];

  // A tool_result came back — produce the closing text turn.
  if (Array.isArray(last?.content)) {
    const results = last.content as { type: string; content?: unknown }[];
    const toolResult = results.find((r) => r.type === "tool_result");
    if (toolResult) {
      const text = JSON.stringify(toolResult.content ?? "");
      if (text.includes("Open times")) {
        // Availability came back — offer a slot, then book it.
        const m = text.match(/start_iso=([0-9TZ:.\-]+)/);
        return {
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "متوفر عندنا مواعيد، بحجزلك أقرب وحدة." },
            {
              type: "tool_use",
              id: `toolu_book_${++callCount}`,
              name: "book_appointment",
              input: {
                service_name: "Checkup",
                start_iso: m ? m[1] : "",
                patient_name: "منى العلي",
              },
            },
          ],
        };
      }
      if (text.includes("Booked:")) {
        return {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "تم تأكيد حجزك! بنشوفك قريباً 🌟" }],
        };
      }
      if (text.includes("Staff have been notified")) {
        return {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "زميلي رح يتواصل معك حالاً." }],
        };
      }
      return { stop_reason: "end_turn", content: [{ type: "text", text: "تمام." }] };
    }
  }

  const userText = typeof last?.content === "string" ? last.content : "";

  // Emergency / complaint → escalate
  if (/نزيف|طوارئ|ألم شديد|زعلان|شكوى/.test(userText)) {
    return {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: `toolu_esc_${++callCount}`,
          name: "escalate_to_human",
          input: { reason: "المريض يذكر نزيفاً — حالة طارئة", urgent: true },
        },
      ],
    };
  }

  // Booking intent → check availability
  if (/موعد|احجز|أحجز|بدي/.test(userText)) {
    const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
    return {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: `toolu_avail_${++callCount}`,
          name: "check_availability",
          input: { service_name: "Checkup", date: tomorrow },
        },
      ],
    };
  }

  // Knowledge question → answer from the system prompt
  if (/سعر|كم|تأمين/.test(userText)) {
    const system = body.system ?? "";
    const priced = /15\.00|كشفية/.test(system);
    return {
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: priced ? "سعر الكشفية 15 دينار." : "رح أتأكد وأرجعلك.",
        },
      ],
    };
  }

  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text: "أهلاً فيك! كيف بقدر أساعدك؟" }],
  };
}

export function startMockAnthropic(port = 4199): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString() || "{}";
      let body: { messages: { role: string; content: unknown }[]; system?: string; model?: string };
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400).end("{}");
        return;
      }
      const scripted = scriptResponse(body);
      const payload = {
        id: `msg_mock_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: body.model ?? "claude-opus-5",
        content: scripted.content,
        stop_reason: scripted.stop_reason,
        stop_sequence: null,
        usage: { input_tokens: 420, output_tokens: 55 },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1]?.includes("mock-anthropic")) {
  void startMockAnthropic().then(() => console.log("[mock-anthropic] listening on :4199"));
}
