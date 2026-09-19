import Link from "next/link";
import { connection } from "next/server";
import { AutoRefresh } from "@/components/client";
import { Card, Empty, MessageStatus, PageHeader } from "@/components/ui";
import { env } from "@/lib/env";
import { formatDateTime } from "@/lib/time";
import { listMessages, type MessageRow } from "@/server/queries";

export const metadata = { title: "Demo phone" };

export default async function PhonePage({ searchParams }: { searchParams: Promise<{ to?: string }> }) {
  await connection();
  const { to } = await searchParams;
  const all = await listMessages({ limit: 500 });
  const e = env();

  // Group by recipient, newest conversation first.
  const threads = new Map<string, MessageRow[]>();
  for (const m of all) {
    if (!threads.has(m.recipient)) threads.set(m.recipient, []);
    threads.get(m.recipient)!.push(m);
  }
  const recipients = [...threads.keys()];
  const active = to && threads.has(to) ? to : recipients[0];
  const conversation = active ? [...threads.get(active)!].reverse() : [];
  const name = conversation[0]?.full_name ?? active;

  return (
    <>
      <AutoRefresh seconds={3} />
      <PageHeader
        title="Demo phone"
        description={
          e.MESSAGING_PROVIDER === "mock"
            ? "What patients would receive on WhatsApp. In demo mode nothing leaves this system."
            : "Messages sent through WhatsApp Cloud API."
        }
      />
      {recipients.length === 0 ? (
        <Card><Empty>No messages yet. Submit the patient form to see WhatsApp messages arrive here.</Empty></Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          <Card title="Chats">
            <ul className="max-h-[70vh] divide-y divide-border overflow-y-auto">
              {recipients.map((r) => {
                const last = threads.get(r)![0]!;
                return (
                  <li key={r}>
                    <Link
                      href={`/phone?to=${encodeURIComponent(r)}`}
                      className={`block px-4 py-3 hover:bg-surface-2 ${r === active ? "bg-primary-soft" : ""}`}
                    >
                      <div className="flex justify-between gap-2 text-sm font-medium">
                        <span className="truncate">{last.full_name ?? r}</span>
                        <span className="num shrink-0 text-xs font-normal text-muted">{formatDateTime(last.created_at)}</span>
                      </div>
                      <div className="truncate text-xs text-muted">{last.body}</div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>

          {/* Phone mock */}
          <div className="mx-auto w-full max-w-sm">
            <div className="overflow-hidden rounded-[2rem] border-8 border-text/90 shadow-xl">
              <div className="flex items-center gap-3 bg-wa-header px-4 py-3 text-white">
                <div className="grid h-9 w-9 place-items-center rounded-full bg-white/20 text-sm font-semibold">
                  {e.HOSPITAL_NAME.charAt(0)}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{e.HOSPITAL_NAME}</div>
                  <div className="text-xs text-white/70">to {name}</div>
                </div>
              </div>
              <div className="flex h-[60vh] flex-col gap-2 overflow-y-auto bg-wa-bg p-3">
                {conversation.map((m) => (
                  <div key={m.message_id} className="max-w-[85%] self-start rounded-lg rounded-tl-none bg-wa-bubble px-3 py-2 shadow-sm">
                    <p className="text-sm whitespace-pre-wrap">{m.body}</p>
                    <div className="mt-1 flex items-center justify-end gap-2">
                      {m.delivery_status !== "sent" && <MessageStatus status={m.delivery_status} />}
                      <span className="num text-[10px] text-muted">{formatDateTime(m.sent_at ?? m.created_at)}</span>
                      {m.delivery_status === "sent" && <span className="text-[10px] text-info">✓✓</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
