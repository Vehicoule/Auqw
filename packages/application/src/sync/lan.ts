/**
 * LAN-scoped host validation shared by the sync dialer (which must
 * only dial LAN literals) and the sync host (which only records
 * LAN-dialable caller endpoints). Every shape that isn't a literal
 * IP — DNS names, `.local`, `localhost` — is refused.
 */

/**
 * Dotted-decimal IPv4 parse — returns null on anything that isn't a
 * strict `a.b.c.d` literal with each octet in canonical form:
 * in range, and no leading zeros (getaddrinfo reads `010` as octal,
 * so a non-canonical literal can resolve to a different address than
 * it spells).
 */
function parseIpv4(host: string): [number, number, number, number] | null {
  const octet = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d?|0)';
  const m = new RegExp(`^(${octet})\\.(${octet})\\.(${octet})\\.(${octet})$`).exec(host);
  if (m === null) {
    return null;
  }
  const octets = m.slice(1).map(Number);
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/**
 * Whole-literal IPv6 parse → eight 16-bit groups + optional zone, or
 * null. Handles `::` compression, a `%zone` scope suffix, and a
 * trailing embedded dotted-quad — and rejects every byte that isn't
 * part of a valid literal, so nothing here can smuggle a DNS name
 * through.
 */
function parseIpv6(
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
 * One bracket-stripped literal parsed both ways: a direct v4 dotted
 * quad, else a v6 group list + zone. `v4` also carries the IPv4-mapped
 * ::ffff:a.b.c.d tail when the literal is v6 — a mapped loopback is
 * still a loopback.
 */
function lanLiteral(bare: string): {
  v4: readonly number[] | null;
  groups: readonly number[] | null;
  zone: string | null;
} {
  const direct = parseIpv4(bare);
  const v6 = direct === null ? parseIpv6(bare) : null;
  const groups = v6?.groups ?? null;
  const v4: readonly number[] | null =
    direct ??
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
  return { v4, groups, zone: v6?.zone ?? null };
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
  const { v4, groups, zone } = lanLiteral(bare);
  // A zone id only exists for link-local addressing — elsewhere it's
  // noise that would reach the dial unsanitized.
  if (zone !== null && groups !== null && (groups[0]! & 0xffc0) !== 0xfe80) {
    return false;
  }
  if (v4 !== null) {
    const [a = -1, b = -1] = v4;
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
 * Every pairable address of a resolved advert, best-first (stable
 * sort — equal ranks keep resolver order), deduped and
 * bracket-stripped so each entry is dialable as-is. The LAN gate
 * decides what MAY be dialed; this ranks what SHOULD be dialed first:
 * non-loopback IPv4 > any other v6 > bare `fe80::` > loopback. A
 * link-local literal without a zone has no egress interface and
 * always fails to connect, so it stays a last resort even though the
 * gate accepts it. Loopback ranks below even that for DISCOVERY: a
 * remote advert's `127.0.0.1`/`::1` points at the browsing machine,
 * not the advertiser — it only stays selectable so a co-located test
 * advert (sim host on the same box) still resolves when it's the only
 * candidate. A dial tries them in order: the first-ranked literal can
 * sit behind a dead route while a lower-ranked one still answers.
 */
export function dialableHostsRanked(
  addresses: readonly string[],
): readonly string[] {
  const ranked: { bare: string; rank: number }[] = [];
  for (const address of addresses) {
    if (typeof address !== 'string' || !isPairableLanHost(address)) {
      continue;
    }
    const bare =
      address.startsWith('[') && address.endsWith(']')
        ? address.slice(1, -1)
        : address;
    const { v4, groups, zone } = lanLiteral(bare);
    const first = groups?.[0];
    const loopback =
      v4?.[0] === 127 ||
      (groups !== null &&
        groups.slice(0, 7).every((g) => g === 0) &&
        groups[7] === 1);
    const rank = loopback
      ? 3 // remote loopback would dial the browser itself
      : groups === null
        ? 0 // IPv4
        : zone === null &&
            first !== undefined &&
            (first & 0xffc0) === 0xfe80
          ? 2 // bare fe80:: — undialable
          : 1;
    // Emit the bracket-stripped literal the gate validated — a
    // `[fd00::8]` form passes isPairableLanHost but neither
    // net.connect nor InetSocketAddress parses brackets.
    ranked.push({ bare, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { bare } of ranked) {
    if (!seen.has(bare)) {
      seen.add(bare);
      out.push(bare);
    }
  }
  return out;
}
