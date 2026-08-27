export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
}

export function ChatLog({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="flex min-h-40 max-h-64 flex-col gap-3 overflow-y-auto pr-1" aria-live="polite">
      {messages.length === 0 ? (
        <p className="m-auto text-center text-sm text-slate-400">Ask your avatar anything.</p>
      ) : (
        messages.map((message) => (
          <div
            className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-6 ${
              message.role === "user"
                ? "self-end rounded-br-sm bg-cyan-500 text-slate-950"
                : message.role === "system"
                  ? "self-center bg-rose-500/15 text-rose-200"
                  : "self-start rounded-bl-sm bg-slate-800 text-slate-100"
            }`}
            key={message.id}
          >
            {message.content}
          </div>
        ))
      )}
    </div>
  );
}
