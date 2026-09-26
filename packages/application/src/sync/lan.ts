/**
 * LAN-scoped host validation shared by the sync dialer (which must
 * only dial LAN literals) and the sync host (which only records
 * LAN-dialable caller endpoints). Every shape that isn't a literal
 * IP — DNS names, `.local`, `localhost` — is refused.
 */

/**
 * Dotted-decimal IPv4 parse — returns null on anything that isn't a
 * strict `a.b.c.d` literal with each octet in range.
 */
export function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) {
    return null;
  }
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255)
    ? [octets[0]!, octets[1]!, octets[2]!, octets[3]!]
    : null;
}

/**
 * Whole-literal IPv6 parse → eight 16-bit groups + optional zone, or
 * null. Handles `::` compression, a `%zone` scope suffix, and a
 * trailing embedded dotted-quad — and rejects every byte that isn't
 * part of a valid literal, so nothing here can smuggle a DNS name
 * through.
 */
export function parseIpv6(
  addr: string,
): { groups: number[]; zone: string | null } | null {
  // A `%zone` suffix selects the egress interface — it can only make
  // the literal MORE local, never redirect it, but an unvalidated
  // zone reaches the dial verbatim, so it must look like an
  // interface name (Linux ifname cap is 15; Windows uses indexes).
  const zoneSplit = addr.split('%');
  if (zoneSplit.length > 2) {
    return null;
  }
  const zone = zoneSplit[1] ?? null;
  // Interface-name shape: plain ifname (`en0`, `eth0`, `wlan0`, or a
  // Windows numeric index) or a VLAN suffix (`eth0.100`). Anything
  // DNS-looking (`evil.com`, a hostname) is refused — the zone only
  // ever names a local interface.
  if (
    zone !== null &&
    (zone.length > 15 ||
      !/^([a-zA-Z0-9_-]+|[a-zA-Z][a-zA-Z0-9_-]*\.[0-9]+)$/.test(zone))
  ) {
    return null;
  }
  const zoneless = zoneSplit[0] ?? '';
  if (zoneless === '') {
    return null;
  }
  const halves = zoneless.split('::');
  if (halves.length > 2) {
    return null;
  }
  const group = (g: string): number | null =>
    /^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : null;
  const leftRaw = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const rightRaw =
    halves[1] === undefined ? null : halves[1] === '' ? [] : halves[1].split(':');
  // An embedded IPv4 tail contributes the last two groups.
  const tailList = rightRaw ?? leftRaw;
  const tail = tailList[tailList.length - 1];
  let v4Groups: number[] = [];
  if (tail !== undefined && tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === null) {
      return null;
    }
    tailList.pop();
    v4Groups = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
  }
  const left = leftRaw.map(group);
  const right = (rightRaw ?? []).map(group);
  if (left.includes(null) || right.includes(null)) {
    return null;
  }
  const leftN = left as number[];
  const rightN = right as number[];
  const total = leftN.length + rightN.length + v4Groups.length;
  if (rightRaw === null) {
    // No `::` — the literal must carry all eight groups exactly.
    if (total !== 8) {
      return null;
    }
    return { groups: [...leftN, ...v4Groups], zone };
  }
  if (total > 7) {
    return null;
  }
  const pad = Array<number>(8 - total).fill(0);
  return { groups: [...leftN, ...pad, ...rightN, ...v4Groups], zone };
}

/**
 * Pairing targets are LAN-scoped: the caller (renderer IPC, or a
 * remote peer's hello) may be compromised, so `host` must be an IP
 * literal a LAN pairing protocol legitimately dials —
 * private/loopback/link-local/CGNAT/ULA — never a DNS name, which
 * could resolve anywhere.
 */
export function isPairableLanHost(host: string): boolean {
  const bare =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const v4direct = parseIpv4(bare);
  const v6 = v4direct === null ? parseIpv6(bare) : null;
  const groups = v6?.groups ?? null;
  // A zone id only exists for link-local addressing — elsewhere it's
  // noise that would reach the dial unsanitized.
  if (
    v6 !== null &&
    v6.zone !== null &&
    groups !== null &&
    (groups[0]! & 0xffc0) !== 0xfe80
  ) {
    return false;
  }
  const v4 =
    v4direct ??
    // IPv4-mapped form: ::ffff:a.b.c.d → groups [0,0,0,0,0,ffff,…].
    (groups !== null &&
    groups.slice(0, 5).every((g) => g === 0) &&
    groups[5] === 0xffff
      ? [
          (groups[6]! >> 8) & 0xff,
          groups[6]! & 0xff,
          (groups[7]! >> 8) & 0xff,
          groups[7]! & 0xff,
        ]
      : null);
  if (v4 !== null) {
    const [a, b] = v4;
    return (
      a === 10 || // RFC1918
      a === 127 || // loopback
      (a === 169 && b === 254) || // link-local
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) // CGNAT (overlay VPNs)
    );
  }
  if (groups === null) {
    return false;
  }
  if (groups.every((g) => g === 0)) {
    return false; // :: — unspecified
  }
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return true; // ::1 loopback
  }
  const first = groups[0]!;
  return (
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xfe00) === 0xfc00 // fc00::/7 ULA
  );
}

/**
 * One dialable address out of a resolved advert's list — the LAN gate
 * decides what MAY be dialed, this picks which SHOULD be dialed first.
 * Ranked: IPv4 > any other v6 > bare `fe80::` — a link-local literal
 * without a zone has no egress interface and always fails to connect,
 * so it's strictly the last resort even though the gate accepts it.
 * Null when no pairable address exists (e.g. only public v4s).
 */
export function pickDialableHost(
  addresses: readonly string[],
): string | null {
  let best: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const address of addresses) {
    if (typeof address !== 'string' || !isPairableLanHost(address)) {
      continue;
    }
    const bare =
      address.startsWith('[') && address.endsWith(']')
        ? address.slice(1, -1)
        : address;
    const v6 = parseIpv4(bare) === null ? parseIpv6(bare) : null;
    const first = v6?.groups[0];
    const rank =
      v6 === null
        ? 0 // IPv4
        : v6.zone === null &&
            first !== undefined &&
            (first & 0xffc0) === 0xfe80
          ? 2 // bare fe80:: — undialable
          : 1;
    if (rank < bestRank) {
      bestRank = rank;
      best = address;
    }
  }
  return best;
}
