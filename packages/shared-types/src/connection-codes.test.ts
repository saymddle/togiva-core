import { describe, expect, it } from "vitest";
import { AssociateOrderRequest, ConnectionCodeDigits } from "./connection-codes.js";

describe("ConnectionCodeDigits", () => {
  it.each(["0000", "0042", "4827", "9999"])("accepts %s", (c) => expect(ConnectionCodeDigits.parse(c)).toBe(c));
  it.each(["123", "12345", "12a4", " 1234", "１２３４", ""])("rejects %j", (c) => expect(ConnectionCodeDigits.safeParse(c).success).toBe(false));
});

describe("AssociateOrderRequest", () => {
  it("requires some order reference", () => {
    expect(AssociateOrderRequest.safeParse({ method: "order_reference", provider: "fixture", idempotencyKey: "abcdefgh" }).success).toBe(false);
    expect(AssociateOrderRequest.safeParse({ method: "order_reference", provider: "fixture", externalOrderId: "ORD-1", idempotencyKey: "abcdefgh" }).success).toBe(true);
  });
});
