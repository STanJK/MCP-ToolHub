# Returning JLCEDA schematic PNGs through ToolHub MCP

> Verified on 2026-11-18 against JLCEDA Pro desktop V4.1.78 and ToolHub's `lceda-pro` module.
>
> Scope: **native EDA schematic export**, not a Windows desktop/window screenshot. This workflow returns **one selected PNG** as a model-visible image without requiring a public image host, shared folder, generic remote shell, or manual attachment.

## 1. Why this exists

An upstream JLCEDA API returns JavaScript `File` objects. ToolHub's `lceda_pro.call(path="invoke")` can execute editor-side JavaScript and return JSON, but a raw `File` object is not an ordinary JSON image payload. The working transport was:

```text
ChatGPT functions.exec
  -> ToolHub MCP lceda_pro.call (path = invoke)
  -> active local JLCEDA session
  -> eda.sch_ManufactureData.getPngFile(...)
  -> JavaScript File (PNG or, for multi-page schematics, ZIP)
  -> select one PNG entry and read Uint8Array
  -> encode PNG bytes to Base64
  -> { name, bytes, b64 } as invoke JSON result
  -> functions.exec parses result.text
  -> image("data:image/png;base64," + b64, "original")
  -> image visible to model for actual visual QA
```

The file bytes travel back through the existing MCP/Tunnel result channel. This **does not** mean the connection itself is offline: the configured tunnel may use network transport. It means no *separate public image-hosting URL* or secondary upload service is needed.

Do not replace visual inspection with successful `invoke`, `save`, or DRC responses: none of those alone proves that a schematic is visually wired and readable.

## 2. Prerequisites

- ToolHub's `lceda-pro` module enabled and connected to an authorized local JLCEDA Pro desktop installation.
- The permitted upstream commands include `lceda-pro.help` and `lceda-pro.call` for `doctor`, `session.list`, and `invoke`.
- An active JLCEDA editor session with the target schematic/project open.
- A host/tool execution environment supporting a model-visible image output function (the example uses `functions.exec`'s `image()` helper). Other MCP clients may need a different content-block adapter.
- The editor invocation identity must be allowed to call the read/export API; restrict generic invocation in ToolHub policy where possible.

Use the documented discovery order (help before CLI calls) and inspect the live editor session rather than treating any session ID as permanent.

## 3. Verified observed result

The 2026-11-18 test returned these actual values:

| Check | Observed |
| --- | --- |
| `doctor` | `connected: true`, `versionMatch: true`, `resultChannel: true` |
| JLCEDA Pro | V4.1.78 |
| Bridge | `4.1.78.34f5b8d9` |
| Editor window | `DD20 Flat MM Preamp` |
| Export call | `eda.sch_ManufactureData.getPngFile("DD20_RIAA_Audit", { width: 1200 })` |
| Returned container | `DD20_RIAA_Audit.zip`, 982,701 bytes |
| Entries | Four `.png` files, one per schematic page |
| Selected entry | `SCH_Flat_MM_Preamp_4-P1_2026-11-18.png` |
| Selected PNG | 306,474 bytes |
| ZIP compression for that entry | `0` (Stored / uncompressed) |
| Host display | `image("data:image/png;base64," + data.b64, "original")` succeeded |

This is a single successful end-to-end example, **not** a guarantee about maximum safe payload size, every ZIP compression method, every editor release, or all MCP clients.

## 4. Complete copyable example (ChatGPT functions.exec)

This is a **host-side** `functions.exec` script. The `edaCode` string is run **inside JLCEDA**, through the real ToolHub `invoke` command. Change `targetFilenameFragment` to distinguish the desired page (not the whole project). The tool name shown is the ToolHub registration used in the test; connector-qualified names may differ between installations.

```javascript
const eda = tools.mcp__MCP_Toolhub_STanJK_PC___lceda_pro_lceda_pro_call;

// The official MCP CLI requires help/discovery before invoking commands.
await tools.mcp__MCP_Toolhub_STanJK_PC___lceda_pro_lceda_pro_help({});

function unwrap(response) {
  const parsed = JSON.parse(response.text);
  if (!parsed.ok) {
    throw new Error(parsed.error?.message || "JLCEDA MCP command failed");
  }
  return parsed.data;
}

const doctor = unwrap(await eda({ path: "doctor", input: {} }));
if (!doctor.connected || !doctor.resultChannel) {
  throw new Error("JLCEDA endpoint is not connected/ready");
}

const sessions = unwrap(await eda({ path: "session.list", input: {} }));
// If multiple windows are open, choose using their title/path deliberately.
const session = sessions.find(
  (item) => item.status === "alive" && item.title.includes("DD20 Flat MM Preamp")
);
if (!session) throw new Error("Target JLCEDA window not found");

const targetFilenameFragment = "4-P1_"; // Replace with the desired page filename fragment.
const edaCode = String.raw`
const file = await eda.sch_ManufactureData.getPngFile(
  "ToolHub_Schematic_Export",
  { width: 1200 }
);
if (!file) throw new Error("getPngFile returned no File");

const raw = new Uint8Array(await file.arrayBuffer());
const target = __CLI__.args.targetFilenameFragment;
const isPng = (a) =>
  a.length >= 8 &&
  a[0] === 137 && a[1] === 80 && a[2] === 78 && a[3] === 71 &&
  a[4] === 13 && a[5] === 10 && a[6] === 26 && a[7] === 10;

let pngBytes, pngName;
if (isPng(raw)) {
  pngBytes = raw;
  pngName = file.name;
} else {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const sig = (at) => view.getUint32(at, true);
  if (raw.length < 22 || sig(0) !== 0x04034b50) {
    throw new Error("Expected PNG or ZIP returned by EDA");
  }

  // ZIP End Of Central Directory: read backwards to account for comments.
  let eocd = -1;
  for (let at = raw.length - 22; at >= Math.max(0, raw.length - 65557); --at) {
    if (sig(at) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) throw new Error("ZIP central directory not found");

  const entries = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  let match = null;
  const names = [];

  for (let i = 0; i < entries; ++i) {
    if (p + 46 > raw.length || sig(p) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory entry");
    }
    const method = view.getUint16(p + 10, true);
    const packedSize = view.getUint32(p + 20, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(raw.subarray(p + 46, p + 46 + nameLength));
    names.push(name);
    if (name.endsWith(".png") && name.includes(target)) {
      if (match) throw new Error("Page selector is ambiguous: " + target);
      match = { name, method, packedSize, localOffset };
    }
    p += 46 + nameLength + extraLength + commentLength;
  }

  if (!match) {
    throw new Error("Target PNG not found. Available entries: " + names.join(", "));
  }

  // Only method 0 (Stored) was verified in the actual test.
  // Never interpret Deflate-compressed bytes as a PNG.
  if (match.method !== 0) {
    throw new Error("Unsupported ZIP method " + match.method +
      "; use a ZIP decompressor for Deflate/method 8");
  }
  const q = match.localOffset;
  if (q + 30 > raw.length || sig(q) !== 0x04034b50) {
    throw new Error("Invalid ZIP local file header");
  }
  const localNameLen = view.getUint16(q + 26, true);
  const localExtraLen = view.getUint16(q + 28, true);
  const dataStart = q + 30 + localNameLen + localExtraLen;
  const dataEnd = dataStart + match.packedSize;
  if (dataEnd > raw.length) throw new Error("Truncated ZIP entry");

  pngBytes = raw.subarray(dataStart, dataEnd);
  pngName = match.name;
}

if (!isPng(pngBytes)) throw new Error("Selected payload is not a PNG");
const MAX_BYTES = 2_000_000; // Client-side guard, not a measured MCP limit.
if (pngBytes.length > MAX_BYTES) {
  throw new Error("PNG too large for this example; export at lower resolution");
}

// Chunk String.fromCharCode to avoid argument-count/stack limits.
const chunks = [];
for (let at = 0; at < pngBytes.length; at += 8192) {
  chunks.push(String.fromCharCode(...pngBytes.subarray(at, at + 8192)));
}

return {
  name: pngName,
  bytes: pngBytes.length,
  b64: btoa(chunks.join(""))
};
`;

const data = unwrap(await eda({
  path: "invoke",
  input: {
    session: session.sessionId,
    code: edaCode,
    args: { targetFilenameFragment },
    timeout: 90000
  }
}));
if (!data.b64 || !data.name || !data.bytes) {
  throw new Error("invoke did not return expected PNG payload");
}

// Do NOT print the Base64 data: send it as a model-visible image item.
text("EDA PNG: " + data.name + " (" + data.bytes + " bytes)");
image("data:image/png;base64," + data.b64, "original");
```

If the EDA API returns a direct PNG rather than a ZIP, the same code checks its PNG signature and forwards it without ZIP parsing. If it returns a ZIP using method 8 (Deflate), the sample **fails explicitly**; add tested decompression support rather than assuming Stored bytes.

## 5. Payload and troubleshooting notes

- **`ok: true` is only command-execution success.** Check the business result (`file` existence, PNG signature, bytes, actual rendered image). A successful DRC is not a visual wiring audit.
- **Do not log or emit full Base64 using `text()`.** Pass it only to `image()`. Base64 expands the wire payload by roughly 4/3, and JSON framing adds more.
- **ZIP is expected for a multi-page schematic.** The observed archive had four PNGs. If the page is renamed, update the selector; do not rely forever on `4-P1_`.
- **Inspect scope.** `getPngFile` is an export of schematic pages, not a desktop screenshot; it does not show dialogs, selections, or desktop chrome.
- **Transport constraints.** Response size, timeout, host image-size limits, and tool-payload limits vary. The 306,474-byte PNG passed in the observed session; the example's 2 MB guard is a conservative implementation choice, not a proven service maximum.
- **No arbitrary filesystem access needed.** The workflow reads bytes from the EDA export returned in memory. `eda.sys_FileSystem.saveFile` is available for deliberate local-file export but was *not used* in the observed image-transfer chain.
- **Do not embed session IDs in committed documentation or automation.** Discover the active session each time. The session used in a conversation can become invalid after restarting JLCEDA.
- **Permissions.** `invoke` is a broad editor scripting surface. Follow the restrictions in [JLCEDA_MCP.md](JLCEDA_MCP.md); do not open unrestricted host execution merely to obtain screenshots.

## 6. Reusable model-side review pattern

For a schematic-editing workflow:

1. Perform the requested editor changes with allowed JLCEDA APIs.
2. Check the editor operation's returned business state and save the target schematic.
3. Export its PNG through `getPngFile` and select the correct page from any ZIP.
4. Return image content through the existing MCP result and the host's image helper.
5. Inspect the **actual wiring**, rail connections, labels, legibility, and element collisions in the rendered image.
6. Read back the netlist or electrical connectivity separately (the rendered picture alone is also insufficient) and run DRC, distinguishing new-page findings from pre-existing issues on other project pages.
7. Only then report completion, including remaining gaps.

### Provenance

This document records an observed ToolHub/JLCEDA run on 2026-11-18. The EDA `getPngFile` response, ZIP entry names, selected file size, and successful `functions.exec.image()` display were verified live. This page is an **operational recipe**, not a claim that generic binary transfer is built into the ToolHub protocol for all modules.
