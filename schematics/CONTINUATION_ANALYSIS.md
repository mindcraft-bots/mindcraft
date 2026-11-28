# Schematic continuation

The analyzer classifies a transformed fixed-origin volume as exact matches,
missing solids, correct air, conflicts, unreadable cells and observable block
entities. It is read-only and cannot identify ownership, hidden block entities,
or prove remote physics safety. It yields during large scans and aborts on
cancellation, world changes or inspection limits.

For analysis and managed recovery, the trust boundary is the exact modern Java
release and the canonical minecraft-data block tables shared with the bot's
registry. Expected and observed names, state IDs and complete scalar properties
must agree with a fresh Prismarine registry decoding. Observations are accepted
only as explicit data-only records or the recognized Prismarine block getter
shape, with own data fields; proxies, accessors, overridden getters and unknown
adapters are unavailable. The observed getter is never executed, and computed
states must agree with the ID. A custom class whose getter uses private fields
cannot safely be supported by cloning or invoking it and is refused. The getter
shape check is not a security brand: it merely selects a data representation, and
registry coherence remains mandatory. This assumes the installed dependencies,
canonical registry tables, bot world reader and process are trusted; it does not
authenticate arbitrary data fabricated by a compromised reader or server.

Entity detection inspects descriptors across the entire non-proxy prototype chain,
including shadowed descriptors. Own data for `entity`, `blockEntity`,
`_blockEntity` and `nbt` is treated as attached when non-null; inherited data,
unrecognized accessors and proxy chains are unreadable. The one reviewed
Prismarine `blockEntity` accessor is not invoked: its known implementation is an
alias of `entity`, whose descriptors are independently checked. This exception
depends on its reviewed behavior, not on the other method's shape or an instance
brand; an altered implementation fails closed. Mineflayer's Java chunk and
tile-entity updates populate Prismarine's own `entity` field from received NBT.
Only data actually delivered and retained by the trusted world reader can be
observed; the protocol cannot prove that absent data means no hidden entity.

The supported addressed form is `continue schematic file name gazebo of pack2 at 120 64 -30 facing east` (orientation is optional). Other continuation
wordings are refused rather than treated as new builds. Coordinates must be
explicit safe integers; the builder never searches for an existing origin.
Existing selector, provenance, transformed-plan, safety and placement checks
remain in force. A trusted authenticated human and `allow` policy are required;
generated-code exposure disables this ingress. Only fixed-origin delicate builds
with at least one exact match, no occupied conflicts or unknown cells, and safe
confirmed placement are permitted. Revalidation detects stale observations, but
does not make a world read and subsequent packet atomic.

`ask` fails closed without an approval flow; `deny` refuses continuation;
`off` disables detection and retains legacy new-build match handling. `allow`
does not turn ordinary builds into continuation. When detection is enabled,
balanced and raise searches first discover possible matches in all candidate
volumes, protecting the whole volume including intended air; raise also refuses
to fill or use a protected volume as foundation. Balanced discovery covers every
integer anchor in the configured horizontal radius, even when site ranking is
sampled. Raise discovery covers its fixed X/Z and bounded rise, restricted to
the dimension's valid volume bounds. Unreadable or inconsistent evidence,
cancellation, or exhausted read/time limits aborts selection rather than using a
partial search. Observations are rechecked before edits, accounting for confirmed
edits by this build. These checks may refuse otherwise buildable sites.

A matching block is only a conservative indication of a possible continuation,
not proof of a structure or its ownership. No protection is promised for origins
outside those declared candidate areas, other orientations, unrelated structures,
or changes between a final inspection and the resulting gameplay packet. The
search does not scan the whole world and cannot provide an atomic world lock.

Managed combat recovery is separate and bound to the original session, source,
plan and world. Under `ask`, `allow` and `deny`, a placement observed before an
interruption cannot currently be reused: the ordered server block updates do not
identify the placing actor, and another player can produce the same observations.
An interrupted session with an observed placement is cancelled immediately, and
the refusal is also written to the operator log because interrupted action output
can be suppressed. Recovery also fails closed for an unattributed cleared obstruction;
uninterrupted or pre-placement interruption recovery remains available. `off`
retains legacy behavior and does not provide this attribution guarantee.

For a partial build, review the actual world, original source, exact origin and
orientation before deciding whether a fresh continuation is appropriate. Under
administrator-configured `allow`, an explicitly trusted human may send, for example,
`Andy continue schematic file name gazebo of pack2 at 120 64 -30 facing east` in
verified native public chat. The same restrictive inspection and placement checks
apply; no ownership is inferred. Under `deny` or the currently unavailable `ask`
flow this request is refused. Offline authentication cannot authorize it.

The authenticated public-chat ingress can authorize an immediate explicit
continuation under administrator opt-in `allow`, but there is no pending request
that binds a later approval or denial to the original source, site snapshot,
world and action lifecycle. `ask` therefore remains unavailable rather than
accepting an unbound or spoofable approval. There is no token, approval syntax or
approval expiry in the current implementation.
