/** Shared by server code and client forms, so it must not import anything server-only. */
export const METHODS = ["cash", "card", "upi", "insurance", "other"] as const;
export type PaymentMethod = (typeof METHODS)[number];
export const METHOD_LABEL: Record<PaymentMethod, string> = { cash: "Cash", card: "Card", upi: "UPI", insurance: "Insurance", other: "Other" };
