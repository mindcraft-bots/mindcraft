# Sources, verification and licensing caveats

## Source identity

The source lock pins the 2026-11-23 Mojang version-manifest snapshot by SHA-256 and each release metadata response by Mojang's manifest SHA-1 plus locally calculated SHA-256. Each 1.14+ source uses the individual `<release>-summary` tag resolved to a full immutable [mcmeta](https://github.com/misode/mcmeta) commit. The lock records URLs and SHA-256 for that commit's version identity, condensed block states and full block identifier registry. The normalizer checks the requested version against the version file and joins the identifier registry, not just the summary. The upstream project describes its data generator sources in its README. A source report's scope and exactness remain its own claims except where checked below.

For 1.13–1.13.2 the locked full generated report is from [Arcensoth/mcdata](https://github.com/Arcensoth/mcdata), pinned to commit `20551aa4e972b0b22a420ed5086782842d722d62` for 1.13 and `f0375a8303f788c8b3a15b944d14ef0faf8fbb98` for 1.13.1. The 1.13.2 profile uses the latter report **only** because the independently generated official 1.13.2 report has exactly the same SHA-256; its own Mojang server jar, metadata and DataVersion are separately pinned. Report hashes and jar URLs/digests are in the lock.

1.13-family DataVersions come from the exact release rows of [PrismarineJS minecraft-data](https://github.com/PrismarineJS/minecraft-data) npm package 3.119.0, not its version-fallback API or block data. The immutable package URL and SHA-256 are in the lock. Its npm integrity, independently checked against the downloaded tarball, is `sha512-RElo0o2RooEzpeQO+QEHzTmHVTgOdbbomGQYBmWIaU1pupEmAItQb+LpJyL2EDXmpKicOU4swtBVzwIWae5l5g==`. This is secondary evidence for those DataVersions. The installed package's API gives stale 1.21.2/1.21.7 registries (1,060 blocks); it was not used to fill any profile.

The normal offline build checks each consumed source's descriptor and actual bytes, including every historical DataVersion descriptor, which must be identical across those releases. It checks the historical server descriptors against Mojang metadata and the separately recorded jar/report attestations below, but **does not consume or rehash server jars** unless `--verify-server-jars` is requested. That option requires the pinned jars in the cache (or `--fetch`); it validates their SHA-1 and SHA-256, but does not run them or reproduce the reports. The documented report-generation comparisons are historical attestations, not checks performed by a normal rebuild. Descriptor and content hashes detect inconsistencies; they do not authenticate a replaced lock, generator, or attestation table.

## Independent Mojang server report checks

On 2026-11-23, the following official server jars were downloaded from the Mojang URLs recorded in their pinned release metadata, checked against metadata SHA-1, and hashed with SHA-256. Each report was generated in an empty directory without a world or custom data packs. The 1.13-family reports were produced using Temurin OpenJDK 8u514-b01 (`OpenJDK8U-jre_x64_linux_hotspot_8u514b01.tar.gz`, SHA-256 `b3e38dc60261a548fe83d297bf6faf7880f1b84f7d48e5741f3c6f3c3021cd4d`), and the modern reports using Temurin OpenJDK 25.0.5.1+2 (`OpenJDK25U-jre_x64_linux_hotspot_25.0.5.1_2.tar.gz`, SHA-256 `2edef9e4f81ec5ee426d023336d4cfbd7b4644e99884e7a73a6a867b70b17acf`). These runtimes were obtained from the Adoptium release API; the version and content digest, rather than the moving `latest` URL, identify the binaries.

| Release | Server jar SHA-1 | Server jar SHA-256 | Generated blocks report SHA-256 | Block IDs |
| --- | --- | --- | --- | ---: |
| 1.13 | d0caafb8438ebd206f99930cfaecfa6c9a13dca0 | e76f3927904d331c969a2c437d5661ac02f24be86062dd1c607bfd4ebdc550b9 | 7a893606b910ef24d17cc7350a3f349dab30bf8e073a8afecbc678fe3648f0ed | 593 |
| 1.13.1 | fe123682e9cb30031eae351764f653500b7396c9 | 2ea6047e7651c429228340acd7d1e35f4f6c7af42f59f92b0b1cd476561253d1 | d386830f6ce9949b1ff893d4588c07dbb5fc23afb8bc2b445ab3b0b5aec68952 | 598 |
| 1.13.2 | 3737db93722a9e39eeada7c27e7aca28b144ffa7 | ffd3aa2c25c5ba68a706b59f2abdc69ac1748e115ca9d3b47941e197736f088e | d386830f6ce9949b1ff893d4588c07dbb5fc23afb8bc2b445ab3b0b5aec68952 | 598 |
| 1.20.2 | 5b868151bd02b41319f54c8d4061b8cae84e665c | 1daee4838569ad46e41f0a6f459684c500c7f2685356a40cfb7e838d6e78eae8 | b136604125b5f0200c476d8fc48ff1efd2920a120b1e7c693b0f0a120d21f852 | 1,003 |
| 1.21.2 | 7bf95409b0d9b5388bfea3704ec92012d273c14c | 3bcbca82b23b0a13f745e25ca5956e33a6f4ccfb5ed451b961c943c0f790418d | 8db9069f23f3285d9737873322ff0cdbf4e741416b5e9c6b0f0d410ef1fec938 | 1,084 |
| 1.21.7 | 05e4b48fbc01f0385adb74bcff9751d34552486c | b955b8f75d811cc326179472174941358eeaf97a68999ee119ccd3873350c4ee | 56ce847593fd1370bc81bf3ca4e08772faa84695862cb60bf1e2aeebdb2e6845 | 1,105 |
| 26.3 | 33680f5f2ac32864d6d7cf5e56a705fdb3e05f4c | d052f14d7a173734fba553711e5b570162e2f2a313267ee31a21b975a679be64 | 7a0de8aaf7b04d00c40b8ffdc4cfe75184cff2e821d336a020573201867105a4 | 1,286 |

Commands, with the paths to the independently verified Java executable and jar substituted, were:

```sh
java -cp /absolute/path/to/server.jar net.minecraft.data.Main --reports
java -DbundlerMainClass=net.minecraft.data.Main -jar /absolute/path/to/server.jar --reports
```

The first command was used for 1.13–1.13.2, the second for 1.20.2 and the three modern releases. The file is `generated/reports/blocks.json` inside each empty working directory. For 1.13 and 1.13.1 the generated bytes matched the pinned Arcensoth reports exactly. For 1.13.2 they matched the 1.13.1 report exactly. For 1.21.2, 1.21.7, and 26.3 the independently generated reports and the joined mcmeta data had identical identifier sets, property domains and defaults. All blocks in those three full reports had Cartesian combinations. Those reports were independently regenerated again during the modern expansion below, and their hashes matched the earlier observations.

The generator enforces independently attested block counts for every release, and modern state counts as listed below. Empty inventories are rejected. Any adjacent transition removing at least 10% of the preceding identifiers requires an explicit lock review: `large_drop_review` with the exact `from` release, integer `removed_count`, SHA-256 of the canonical JSON sorted removed-ID array (including its final newline) in `removed_sha256`, and a nonblank `reason`. This guard counts removals even when additions mask a net drop; it cannot establish completeness or correctness of a reviewed input, and a gap has no adjacent comparison.


### Bounded 1.20.5–26.3 expansion

On 2026-11-23 all 19 exact release jars were independently downloaded and executed in fresh temporary directories, with a 1 GiB heap and no world or custom packs. The batch tool checked each release metadata URL and SHA-1 against the pinned Mojang manifest and its bytes against both pinned hashes; each jar was checked against metadata size and SHA-1 and locally SHA-256 hashed. Embedded jar identity and DataVersion were checked against the exact release and pinned summary. Each report was normalized with duplicate/default/domain and complete-tuple validation; all IDs, known schemas and defaults matched that release's pinned summary. Every observed block was Cartesian **as proven by its report**, not inferred from summary domains. Feature flags remain unknown. No jar or raw report is redistributed.

1.20.5–1.21.11 used Temurin 21.0.13.1+2, archive `OpenJDK21U-jre_x64_linux_hotspot_21.0.13.1_2.tar.gz`, SHA-256 `18f44fab9065217f3ba61d0eef8a7b5f3c3713aa7293001b0d4ac10ede3850f0`, acquired from the Adoptium API and verified against its package checksum. 26.1–26.3 used the Temurin 25.0.5.1+2 archive identified above. Metadata requests Java 21 and 25 respectively. Each result below is from its own execution even when report bytes match. The SHA-1 and jar SHA-256, exact Mojang URLs, report SHA-256, Java major and summary/metadata hashes are also pinned per release in the source lock; the generator independently checks attestations, DataVersions, block counts and modern total state counts. Local hashes are attestations, not signatures.

| Release | DataVersion | Blocks | States | Server SHA-1 | Server SHA-256 | Report SHA-256 |
| --- | ---: | ---: | ---: | --- | --- | --- |
| 1.20.5 | 3837 | 1060 | 26684 | 79493072f65e17243fd36a699c9a96b4381feb91 | f8f6a38fededc12d6bbac21e5341c168a7c9bf4ef90193fcf0abcc1366c42bac | 0dde7f869588905763ea6ff2e7e01bec1db740a58d27477fd27c2f07fb029f73 |
| 1.20.6 | 3839 | 1060 | 26684 | 145ff0858209bcfc164859ba735d4199aafa1eea | c6d01d018ca782e506f0ec60652d47fd565078be9122b625c1681bc86c29c7ec | 0dde7f869588905763ea6ff2e7e01bec1db740a58d27477fd27c2f07fb029f73 |
| 1.21 | 3953 | 1060 | 26684 | 450698d1863ab5180c25d7c804ef0fe6369dd1ba | c96394da86f9d9f9ef7ca2d2ee1f2f0980c29b7aa5c94b43c02c50435dbcf53f | 0dde7f869588905763ea6ff2e7e01bec1db740a58d27477fd27c2f07fb029f73 |
| 1.21.1 | 3955 | 1060 | 26684 | 59353fb40c36d304f2035d51e7d6e6baa98dc05c | e3bc55693e93cda0188f2e60aea28113fc647c5e85a15fa3d1b347349231b4bb | 0dde7f869588905763ea6ff2e7e01bec1db740a58d27477fd27c2f07fb029f73 |
| 1.21.2 | 4080 | 1084 | 27318 | 7bf95409b0d9b5388bfea3704ec92012d273c14c | 3bcbca82b23b0a13f745e25ca5956e33a6f4ccfb5ed451b961c943c0f790418d | 8db9069f23f3285d9737873322ff0cdbf4e741416b5e9c6b0f0d410ef1fec938 |
| 1.21.3 | 4082 | 1084 | 27318 | 45810d238246d90e811d896f87b14695b7fb6839 | e153b89b02c0839cdf5e8c1d57c80dd42a3fffb80c60817632080c041bf8afb5 | 8db9069f23f3285d9737873322ff0cdbf4e741416b5e9c6b0f0d410ef1fec938 |
| 1.21.4 | 4189 | 1095 | 27866 | 4707d00eb834b446575d89a61a11b5d548d8c001 | 1066970b09e9c671844572291c4a871cc1ac2b85838bf7004fa0e778e10f1358 | 381aaf2729f48928011683b4364e6a3053c0dd986f00126d77822a68b252d1a5 |
| 1.21.5 | 4325 | 1104 | 27914 | e6ec2f64e6080b9b5d9b471b291c33cc7f509733 | ae7681dadce21b6b4017d28e7eb567d86b6c100a6969994f540b9e54f812dc29 | 8ab11b6855cfdad4dc15fed915d1cba96a7748ebe8b3324041e0c4e4e1dfb724 |
| 1.21.6 | 4435 | 1105 | 27946 | 6e64dcabba3c01a7271b4fa6bd898483b794c59b | 08abf384c48afb9e822144ad8a99166482857994389269e26c6a04c6c91d9171 | 56ce847593fd1370bc81bf3ca4e08772faa84695862cb60bf1e2aeebdb2e6845 |
| 1.21.7 | 4438 | 1105 | 27946 | 05e4b48fbc01f0385adb74bcff9751d34552486c | b955b8f75d811cc326179472174941358eeaf97a68999ee119ccd3873350c4ee | 56ce847593fd1370bc81bf3ca4e08772faa84695862cb60bf1e2aeebdb2e6845 |
| 1.21.8 | 4440 | 1105 | 27946 | 6bce4ef400e4efaa63a13d5e6f6b500be969ef81 | 2349d9a8f0d4be2c40e7692890ef46a4b07015e7955b075460d02793be7fbbe7 | 56ce847593fd1370bc81bf3ca4e08772faa84695862cb60bf1e2aeebdb2e6845 |
| 1.21.9 | 4554 | 1166 | 29671 | 11e54c2081420a4d49db3007e66c80a22579ff2a | ebc5161abcd57523c14a04ce108f0b671da0d0d74a28926b19a7d139ebabaf31 | 375189fda2c2d4bc65f34a248d24c56167369fbcf5e20b6c9350dc57404c85a9 |
| 1.21.10 | 4556 | 1166 | 29671 | 95495a7f485eedd84ce928cef5e223b757d2f764 | 5bb64dc47379903e8f288bd6a4b276e889075c5c0f4c0b714e958d835c1874e7 | 375189fda2c2d4bc65f34a248d24c56167369fbcf5e20b6c9350dc57404c85a9 |
| 1.21.11 | 4671 | 1166 | 29671 | 64bb6d763bed0a9f1d632ec347938594144943ed | f83b8e093865806f931c7e34aae41b177d4c076335263dd124c75d6d65dd1726 | 293ff1dbba615e5dd8f7d9b9e60adc26e040962fd6113b1f4e820060e2c8ba8b |
| 26.1 | 4786 | 1168 | 29873 | 3872a7f07a1a595e651aef8b058dfc2bb3772f46 | 98ab064389a8b34d48ac3d4c5ed858dd9433d0dfd1a12e1cbbda916448d92994 | c4f6aafb57a085df217fcb93533de7c8baa5711ff6eecad07563b28813713cc0 |
| 26.1.1 | 4788 | 1168 | 29873 | 49c8195703ad0ba4f0a4efbccfd85a4a8ca57431 | d792784979722dc35144acffb953554e707445c62450550044c4281e632cbbcc | c4f6aafb57a085df217fcb93533de7c8baa5711ff6eecad07563b28813713cc0 |
| 26.1.2 | 4790 | 1168 | 29873 | 97ccd4c0ed3f81bbb7bfacddd1090b0c56f9bc51 | cd47e7c38328f64768fd17af8fcd8b22496b40b63d4ffee81e71ae059fedcb42 | c4f6aafb57a085df217fcb93533de7c8baa5711ff6eecad07563b28813713cc0 |
| 26.2 | 4903 | 1196 | 32366 | 823e2250d24b3ddac457a60c92a6a941943fcd6a | cdacdfb25898de5e4b4b0e5ddcc2722f77067e46605709c2d886c000ebb63ec5 | dec22eb9547b0bbea396cbf35569f7ec81b7be662775ce03dc2236227473af7b |
| 26.3 | 5023 | 1286 | 35723 | 33680f5f2ac32864d6d7cf5e56a705fdb3e05f4c | d052f14d7a173734fba553711e5b570162e2f2a313267ee31a21b975a679be64 | 7a0de8aaf7b04d00c40b8ffdc4cfe75184cff2e821d336a020573201867105a4 |

Reproduce with the batch command below, adding `--java21` and `--java25` paths and listing the desired exact releases. Existing lock entries additionally cause the runner to reject jar or report SHA-256 differences. The default offline generator consumes reports by content hash; `--verify-server-jars` additionally rehashes pinned jars but does not rerun them. No live server placement test was performed.

```sh
python3 schematics/tooling/block_history/report_batch.py --cache /tmp/history-cache \
  --java8 /path/to/verified-java8/bin/java --java16 /path/to/verified-java17/bin/java \
  --java17 /path/to/verified-java17/bin/java --java21 /path/to/verified-java21/bin/java \
  --java25 /path/to/verified-java25/bin/java --seconds 1800 --per-release-seconds 110 \
  --results /tmp/modern-history-results.json --versions 1.20.5 1.20.6 1.21 1.21.1 \
  1.21.2 1.21.3 1.21.4 1.21.5 1.21.6 1.21.7 1.21.8 1.21.9 1.21.10 1.21.11 \
  26.1 26.1.1 26.1.2 26.2 26.3
```

### Bounded 1.14–1.20.4 expansion

On 2026-11-23, all 28 remaining partial releases were independently executed, in addition to the previously verified 1.20.2. Each exact release metadata response was checked against the pinned manifest SHA-1 and local SHA-256; the exact Mojang server download was checked against its metadata size and SHA-1, and locally hashed with SHA-256 before execution. Each jar's embedded version identity and world version were checked against that release and its pinned summary DataVersion. Each run used a fresh temporary working directory, no world or custom packs, and a 1 GiB Java heap cap. The local reports were checked for duplicate states, unique defaults, property domains and actual legal combinations; identifier sets and all summary-known schemas were compared with the exact release's pinned summary. Every observed block's combinations were Cartesian. Jars, extracted libraries and raw reports remain in the private temporary cache, not the repository.

The 1.14–1.16.5 runs used the verified Temurin 8u514-b01 archive named above; 1.17–1.20.4 used the verified Temurin 17.0.21.1+2 archive described below. Mojang metadata specifies Java 16 for 1.17 and 1.17.1: the compatible Java 17 runtime was used for both, not a Java 16 binary. An Adoptium Java 16 JRE release API query returned HTTP 404. The 1.14, 1.14.1, and 1.14.2 jars have version IDs consisting of the release name and a build identifier, rather than the bare release name. The exact pinned IDs and release targets are checked by the batch tool. Mojang's manifest calls each a release, but the 1.14 and 1.14.1 jar identities themselves say `stable: false`; this discrepancy is retained, not silently rewritten.

The batch initially rejected those three unusual identities; after inspecting their SHA-1-verified jars, it was retried with exact, release-specific ID, stability and release-target checks. Matching report hashes below reflect independently executed jars, not evidence inherited from a neighboring release. DataVersion, block counts and states are recorded per jar. The source lock contains the per-release URLs and metadata hashes as well as both jar hashes and report hash. The generator separately checks the pinned DataVersion, counts and jar/report attestations. As with all local attestations, the checks cannot authenticate a replaced generator, lock or attestation table.

| Release | DataVersion | Block IDs | States | Server SHA-1 | Server SHA-256 | Report SHA-256 |
| --- | ---: | ---: | ---: | --- | --- | --- |
| 1.14 | 1952 | 676 | 11,271 | f1a0073671057f01aa843443fef34330281333ce | 671e3d334dd601c520bf1aeb96e49038145172bef16bc6c418e969fd8bf8ff6c | 06a0501dd51921ff1f99275285405d9e1645fdf9578aec6f79954c9ff151e4e5 |
| 1.14.1 | 1957 | 676 | 11,271 | ed76d597a44c5266be2a7fcd77a8270f1f0bc118 | f822f0b730b7e1f05fca84248a6873400bac4ca449ff6762a55cab3d68b1f03e | 06a0501dd51921ff1f99275285405d9e1645fdf9578aec6f79954c9ff151e4e5 |
| 1.14.2 | 1963 | 676 | 11,271 | 808be3869e2ca6b62378f9f4b33c946621620019 | b47fd85155ae77c2bc59e62a215310c4dce87c7dfdf7588385973fa20ff4655b | 06a0501dd51921ff1f99275285405d9e1645fdf9578aec6f79954c9ff151e4e5 |
| 1.14.3 | 1968 | 676 | 11,271 | d0d0fe2b1dc6ab4c65554cb734270872b72dadd6 | 942256f0bfec40f2331b1b0c55d7a683b86ee40e51fa500a2aa76cf1f1041b38 | 06a0501dd51921ff1f99275285405d9e1645fdf9578aec6f79954c9ff151e4e5 |
| 1.14.4 | 1976 | 676 | 11,271 | 3dc3d84a581f14691199cf6831b71ed1296a9fdf | 5ecdedab3a6e129321a444490d0a467c25ea702a24a99cebe3b6aed41f8f5729 | 06a0501dd51921ff1f99275285405d9e1645fdf9578aec6f79954c9ff151e4e5 |
| 1.15 | 2225 | 680 | 11,337 | e9f105b3c5c7e85c7b445249a93362a22f62442d | e0fe1749263b5ec211b358b598b46e787645bffa8411414f0c812a92bdc70c84 | 636129d6a1e2a8066a3dc96acfa0227af40c4ee13ea69e1fa81a90d75b232871 |
| 1.15.1 | 2227 | 680 | 11,337 | 4d1826eebac84847c71a77f9349cc22afd0cf0a1 | a0c062686bee5a92d60802ca74d198548481802193a70dda6d5fe7ecb7207993 | 636129d6a1e2a8066a3dc96acfa0227af40c4ee13ea69e1fa81a90d75b232871 |
| 1.15.2 | 2230 | 680 | 11,337 | bb2b6b1aefcd70dfd1892149ac3a215f6c636b07 | 80cf86dc2004ec6a2dc0183d1c75a9af3ba0669f7c332e4247afb1d76fb67e8a | 636129d6a1e2a8066a3dc96acfa0227af40c4ee13ea69e1fa81a90d75b232871 |
| 1.16 | 2566 | 763 | 17,104 | a0d03225615ba897619220e256a266cb33a44b6b | 7d2d2d127b90baf2bd8fc61092cbff42bea1bdfae30a2838f45edb31294979b9 | 52bdcdfd178b3990ae120daa75697ea9a06e4243e4e137623c9a141dc7a7b50b |
| 1.16.1 | 2567 | 763 | 17,104 | a412fd69db1f81db3f511c1463fd304675244077 | 2782d547724bc3ffc0ef6e97b2790e75c1df89241f9d4645b58c706f5e6c935b | 52bdcdfd178b3990ae120daa75697ea9a06e4243e4e137623c9a141dc7a7b50b |
| 1.16.2 | 2578 | 763 | 17,112 | c5f6fb23c3876461d46ec380421e42b289789530 | 2902ed3ff84e4f810a2c0620c6b6df9c3ef8488b272c61274d5eac2433876f39 | 03ca0823dc7257851c7e946f5929c7d8334d106d671d5d9438a188048df24cbc |
| 1.16.3 | 2580 | 763 | 17,112 | f02f4473dbf152c23d7d484952121db0b36698cb | 32e450e74c081aec06dcfbadfa5ba9aa1c7f370bd869e658caec0c3004f7ad5b | 03ca0823dc7257851c7e946f5929c7d8334d106d671d5d9438a188048df24cbc |
| 1.16.4 | 2584 | 763 | 17,112 | 35139deedbd5182953cf1caa23835da59ca3d7cd | 444d30d903a1ef489b6737bb9d021494faf23434ca8568fd72ce2e3d40b32506 | 03ca0823dc7257851c7e946f5929c7d8334d106d671d5d9438a188048df24cbc |
| 1.16.5 | 2586 | 763 | 17,112 | 1b557e7b033b583cd9f66746b7a9ab1ec1673ced | 58f329c7d2696526f948470aa6fd0b45545039b64cb75015e64c12194b373da6 | 03ca0823dc7257851c7e946f5929c7d8334d106d671d5d9438a188048df24cbc |
| 1.17 | 2724 | 898 | 20,342 | 0a269b5f2c5b93b1712d0f5dc43b6182b9ab254e | 7b390d8d9f6b5649b226d82686aec7f11bd9aa4430bb5cac9072ffd32f3c1f4b | e7bc901b0b1b08672331d365686fde578e597fe342312356c1c4edea109765a2 |
| 1.17.1 | 2730 | 898 | 20,342 | a16d67e5807f57fc4e550299cf20226194497dc2 | e8c211b41317a9f5a780c98a89592ecb72eb39a6e475d4ac9657e5bc9ffaf55f | e7bc901b0b1b08672331d365686fde578e597fe342312356c1c4edea109765a2 |
| 1.18 | 2860 | 898 | 20,342 | 3cf24a8694aca6267883b17d934efacc5e44440d | 8417edceb471b38a59a6ce260f3aa1479e95264a38eb56283bdf24ec98647e6f | e7bc901b0b1b08672331d365686fde578e597fe342312356c1c4edea109765a2 |
| 1.18.1 | 2865 | 898 | 20,342 | 125e5adf40c659fd3bce3e66e67a16bb49ecc1b9 | ebcd120ad81480b968a548df6ffb83b88075e95195c8ff63d461c9df4df5dbdf | e7bc901b0b1b08672331d365686fde578e597fe342312356c1c4edea109765a2 |
| 1.18.2 | 2975 | 898 | 20,342 | c8f83c5655308435b3dcf03c06d9fe8740a77469 | 57be9d1e35aa91cfdfa246adb63a0ea11a946081e0464d08bc3d36651718a343 | e7bc901b0b1b08672331d365686fde578e597fe342312356c1c4edea109765a2 |
| 1.19 | 3105 | 933 | 21,448 | e00c4052dac1d59a1188b2aa9d5a87113aaf1122 | deefd056f0cf89c3d7fd48d03f56a8a73943586e8c061fdabd0fd92d32ced2b2 | 2f14c76c27381e0f995c34302d55efd4de25dd884097eb35dcc2b1b4d1d5b419 |
| 1.19.1 | 3117 | 933 | 21,448 | 8399e1211e95faa421c1507b322dbeae86d604df | f15b93c25ac7343ae8db6e7883a97f11777baaee924e7a3c7aeed826b155b233 | 2f14c76c27381e0f995c34302d55efd4de25dd884097eb35dcc2b1b4d1d5b419 |
| 1.19.2 | 3120 | 933 | 21,448 | f69c284232d7c7580bd89a5a4931c3581eae1378 | b26727069ef5f61c704add9a378ac90e3d271fd7876c0bd3dcfbe9fd0bec4d96 | 2f14c76c27381e0f995c34302d55efd4de25dd884097eb35dcc2b1b4d1d5b419 |
| 1.19.3 | 3218 | 972 | 23,232 | c9df48efed58511cdd0213c56b9013a7b5c9ac1f | 4ebd3ad142512953d0193ae3a1d1a30c896907de7c68780977151f6cc79f1e1b | fe59b6735eaa1b08d71c5be41ad8295fbbb44586192b3962778eec03caa77fac |
| 1.19.4 | 3337 | 998 | 23,725 | 8f3112a1049751cc472ec13e397eade5336ca7ae | a524a10da550741785c8c3a0fb39047f106b0c7c2cfa255e8278cb6f1abe3f53 | 1a59d207655f0a8dfacd58fc7d71d33cf1ebf209e5764edfa770f70528e7df78 |
| 1.20 | 3463 | 1,003 | 24,135 | 15c777e2cfe0556eef19aab534b186c0c6f277e1 | ff41c542cec182ce74508a5e42194e0f4009341de75f0a7bf770d18cf701d56b | f10d5da83ec8cd995d4f484b788c5b1467a490728e687c629a681450e3253017 |
| 1.20.1 | 3465 | 1,003 | 24,135 | 84194a2f286ef7c14ed7ce0090dba59902951553 | 3af73a9dc5a102e38147946360dd27d4d70bae7055bf91cf2151cd5d121b79e0 | f10d5da83ec8cd995d4f484b788c5b1467a490728e687c629a681450e3253017 |
| 1.20.3 | 3698 | 1,058 | 26,644 | 4fb536bfd4a83d61cdbaf684b8d311e66e7d4c49 | 36ed89be93f182034df0678bce957b5442f0c6905f41e94ff6a0521b2e138bae | 18d83f2c0c04adda138cd8caeb8db14442628f1e6ca3c949b202db2d63573f73 |
| 1.20.4 | 3700 | 1,058 | 26,644 | 8dd1a28015f51b1803213892b50b7b4fc76e594d | c03fa6f39daa69ddf413c965a3a83084db746a7a138ce535a693293b5472d363 | 18d83f2c0c04adda138cd8caeb8db14442628f1e6ca3c949b202db2d63573f73 |

To reproduce, first populate a private content-addressed cache with the pinned manifest, metadata and mcmeta files (the mutable manifest URL requires the original snapshot if it has changed). For example, this downloads and hash-checks the inputs for the 29 report-backed releases; it does not fetch local reports or execute servers:

```sh
python3 - <<'PY'
import json, sys
from pathlib import Path
sys.path.insert(0, 'schematics/tooling/block_history')
import generate as g
cache = Path('/tmp/history-cache')
lock = json.loads((g.ROOT / 'sources.lock.json').read_bytes())
g.read_source(lock['manifest'], cache, True)
for release in lock['releases']:
    if 'local_report' in release:
        for key in ('mojang_metadata', 'version_info', 'blocks', 'registries'):
            g.read_source(release[key], cache, True)
PY
```

Obtain and checksum the documented Adoptium archives from the distribution, unpack outside the repository, and run the bounded helper with verified executable paths, an external cache and an external results file. The helper downloads only exact official server URLs from pinned metadata, checks hashes and version identity, runs each in a separate temporary directory, validates combinations and summary joins, and writes the raw reports and jars only to the supplied cache. It does not update the lock automatically. Review its JSON results and compare the table and lock before rebuilding; it returns nonzero if any release fails. Its deadline is checked between releases and each Java subprocess has a separate timeout; network read timeouts also apply, so the wall-clock deadline is not a strict operating-system kill deadline. Server execution is not sandboxed; run only in a suitable isolated environment.

```sh
python3 schematics/tooling/block_history/report_batch.py --cache /tmp/history-cache \
  --java8 /path/to/verified-java8/bin/java --java16 /path/to/verified-java17/bin/java \
  --java17 /path/to/verified-java17/bin/java --seconds 900 --per-release-seconds 100 \
  --results /tmp/history-results.json --versions 1.14 1.14.1 1.14.2 1.14.3 1.14.4 \
  1.15 1.15.1 1.15.2 1.16 1.16.1 1.16.2 1.16.3 1.16.4 1.16.5 \
  1.17 1.17.1 1.18 1.18.1 1.18.2 1.19 1.19.1 1.19.2 1.19.3 1.19.4 \
  1.20 1.20.1 1.20.2 1.20.3 1.20.4
python3 schematics/tooling/block_history/generate.py --cache /tmp/history-cache --fetch
python3 schematics/tooling/block_history/generate.py --cache /tmp/history-cache --check --verify-server-jars
```

The last verification also requires the 1.13-family jars. A normal build requires the report bytes but not server jars; `--verify-server-jars` rehashes jars without executing them. The helper does not validate the Java distribution itself: independently verify its published archive checksum and binary before execution.

### Reproducing the 1.20.2 report

Mojang's pinned manifest identifies the exact [release metadata](https://piston-meta.mojang.com/v1/packages/2de0c0ee516b632aab03cd5ea4d34e5aafcdf130/1.20.2.json), SHA-1 `2de0c0ee516b632aab03cd5ea4d34e5aafcdf130`, SHA-256 `e17e1d550a08e949f419a6c0a81643326b0d5383706729f8b964673b0bd94f19`. It specifies Java 17 and the [48,285,806-byte server](https://piston-data.mojang.com/v1/objects/5b868151bd02b41319f54c8d4061b8cae84e665c/server.jar); verify both server hashes in the table before executing it. On 2026-11-23 the report was generated in an empty temporary directory with Temurin 17.0.21.1+2, Adoptium asset `OpenJDK17U-jre_x64_linux_hotspot_17.0.21.1_2.tar.gz`, SHA-256 `5a092a0bc21de4c3d855480edd7945be9cfe157b38cdb84dac280511893bb009`. The runtime was obtained via the [Adoptium API](https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jre&os=linux&vendor=eclipse); its published checksum was verified. The moving API URL is not the runtime identity.

Run the second report command above with the verified Java 17 and jar paths in a new empty temporary directory, without a world or custom packs. Check the generated report SHA-256 against the table and place that file in the private cache named by its digest (`b136604125b5f0200c476d8fc48ff1efd2920a120b1e7c693b0f0a120d21f852`). The bundled server's version identity reports release 1.20.2, stable, and world version 3578, matching the pinned mcmeta DataVersion. The generator refuses a missing or mismatched locally generated report even with `--fetch`; it verifies the pinned metadata, exact-release jar descriptor, Java major version and independent jar/report attestation. `--verify-server-jars` additionally rehashes the pinned jar bytes but does not rerun the report. The report's 1,003 IDs exactly match the release's pinned mcmeta registry, and the 643 summary-known schemas match its domains and defaults. The report establishes the other 360 schemas, including air and stone, and enumerates 24,276 unique states; for each block its states equal the Cartesian product of its property domains. The normalizer checks this rather than assuming it. This report is not reused for any other release.

The generator report is a vanilla data-generator snapshot, not proof that every registry entry is enabled by a particular world or feature-flag set. The feature flags remain unknown; no semantic equivalence, placement, gameplay or server compatibility is inferred from a matching state string. The raw report, extracted libraries, server jar and runtime remain outside the repository.

## Rights and distribution

Mojang content is subject to its own terms. mcmeta says its data and assets come from Mojang's data generator and API; a grant for redistributing all derived material was not established. Arcensoth report redistribution terms likewise were not established here. Accessible source URLs or hashes do not confer permission. This tree distributes compact normalized factual identifiers, property value domains, defaults and observed diffs, not original raw reports, game assets, descriptions or wiki text. This minimization is not a legal opinion; downstream distributors should review applicable rights and obligations. Raw source cache and downloaded jars are deliberately excluded from the tree. Minecraft Wiki text and its noncommercial/share-alike license were not used as dataset sources.
