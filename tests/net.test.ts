import { expect, test } from "bun:test";
import { inCidrs, parseCidrs } from "../src/server/net";

test("trusted-proxy CIDRs: loopback and private addresses match, public ones don't", () => {
  const c = parseCidrs("127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7");
  for (const ip of ["127.0.0.1", "::1", "10.1.2.3", "172.18.0.5", "::ffff:172.20.0.2", "192.168.50.7", "fd12:3456::1"]) expect(inCidrs(ip, c)).toBe(true);
  for (const ip of ["8.8.8.8", "172.32.0.1", "2001:db8::1", "::ffff:8.8.8.8", "not-an-ip", ""]) expect(inCidrs(ip, c)).toBe(false);
  expect(() => parseCidrs("300.1.1.1/8")).toThrow();
});
