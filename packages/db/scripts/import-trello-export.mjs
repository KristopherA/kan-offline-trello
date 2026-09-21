#!/usr/bin/env node

import { randomInt } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const UID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

const TRELLO_COLOURS = {
  green: "#4bce97",
  yellow: "#f5cd47",
  orange: "#fea362",
  red: "#f87168",
  purple: "#9f8fef",
  blue: "#579dff",
  sky: "#6cc3e0",
  lime: "#94c748",
  pink: "#e774bb",
  black: "#8590a2",
  green_dark: "#1f845a",
  yellow_dark: "#946f00",
  orange_dark: "#c25100",
  red_dark: "#c9372c",
  purple_dark: "#6e5dc6",
  blue_dark: "#0c66e4",
  sky_dark: "#227d9b",
  lime_dark: "#5b7f24",
  pink_dark: "#ae4787",
  black_dark: "#626f86",
  green_light: "#baf3db",
  yellow_light: "#f8e6a0",
  orange_light: "#fedec8",
  red_light: "#ffd5d2",
  purple_light: "#dfd8fd",
  blue_light: "#cce0ff",
  sky_light: "#c6edfb",
  lime_light: "#d3f1a7",
  pink_light: "#fdd0ec",
  black_light: "#dcdfe4",
};

const asArray = (value) => (Array.isArray(value) ? value : []);
const asString = (value, fallback = "") =>
  typeof value === "string" ? value : fallback;
const truncate = (value, length) => asString(value).slice(0, length);
const byPosition = (a, b) =>
  (Number.isFinite(Number(a?.pos)) ? Number(a.pos) : 0) -
  (Number.isFinite(Number(b?.pos)) ? Number(b.pos) : 0);

function generateUID() {
  let value = "";
  while (value.length < 12) value += UID_ALPHABET[randomInt(UID_ALPHABET.length)];
  return value;
}

function slugPart(value) {
  return asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function looksLikeBoard(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.name === "string" &&
    Array.isArray(value.lists) &&
    Array.isArray(value.cards)
  );
}

export function discoverBoardPayloads(value, sourceFile, depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return [];
  if (looksLikeBoard(value)) return [{ board: value, sourceFile }];

  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      discoverBoardPayloads(item, sourceFile, depth + 1),
    );
  }

  const preferred = ["boards", "data", "exports"];
  const entries = Object.entries(value).sort(([left], [right]) => {
    const leftIndex = preferred.indexOf(left);
    const rightIndex = preferred.indexOf(right);
    return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex);
  });

  return entries.flatMap(([, child]) =>
    discoverBoardPayloads(child, sourceFile, depth + 1),
  );
}

async function walkFiles(source) {
  const stat = await fs.stat(source);
  if (stat.isFile()) return [source];
  if (!stat.isDirectory()) throw new Error(`Source is not a file or directory: ${source}`);

  const files = [];
  const queue = [source];
  while (queue.length > 0) {
    const directory = queue.shift();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  return files;
}

export async function scanExport(source) {
  const files = await walkFiles(source);
  const jsonFiles = files.filter((file) => file.toLowerCase().endsWith(".json"));
  const csvFiles = files.filter((file) => file.toLowerCase().endsWith(".csv"));
  const discovered = [];
  const parseErrors = [];

  for (const file of jsonFiles) {
    try {
      const contents = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "");
      const value = JSON.parse(contents);
      discovered.push(...discoverBoardPayloads(value, file));
    } catch (error) {
      parseErrors.push({ file, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const unique = new Map();
  for (const item of discovered) {
    const sourceId = asString(item.board.id);
    const key = sourceId || `${item.sourceFile}:${item.board.name}`;
    if (!unique.has(key)) unique.set(key, item);
  }

  return {
    boards: [...unique.values()],
    jsonFileCount: jsonFiles.length,
    csvFileCount: csvFiles.length,
    parseErrors,
  };
}

function labelKey(label) {
  return asString(label?.id) || `${asString(label?.name)}:${asString(label?.color)}`;
}

function labelColour(colour) {
  if (!colour) return "#8590a2";
  return TRELLO_COLOURS[colour] ?? "#0d9488";
}

function formatCustomFieldValue(item, definition) {
  if (item?.value && typeof item.value === "object") {
    const value = Object.values(item.value).find(
      (candidate) => candidate !== undefined && candidate !== null && candidate !== "",
    );
    if (value !== undefined) return String(value);
  }

  if (item?.idValue) {
    const option = asArray(definition?.options).find(
      (candidate) => candidate?.id === item.idValue,
    );
    return asString(option?.value?.text, asString(option?.name, item.idValue));
  }

  return "";
}

function escapeMarkdown(value) {
  return asString(value).replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function cardDescription(card, board, memberById, customFieldById) {
  const sections = [];
  if (asString(card.desc).trim()) sections.push(asString(card.desc).trim());

  const metadata = [];
  if (card.url || card.shortUrl) {
    metadata.push(`- Original Trello card: ${card.url ?? card.shortUrl}`);
  }

  const members = asArray(card.idMembers)
    .map((id) => memberById.get(id))
    .filter(Boolean)
    .map((member) => member.fullName || member.username || member.id);
  if (members.length) metadata.push(`- Trello members: ${members.join(", ")}`);

  const customFields = asArray(card.customFieldItems)
    .map((item) => {
      const definition = customFieldById.get(item.idCustomField);
      const value = formatCustomFieldValue(item, definition);
      return value ? `${definition?.name ?? item.idCustomField}: ${value}` : null;
    })
    .filter(Boolean);
  if (customFields.length) {
    metadata.push("- Trello custom fields:");
    metadata.push(...customFields.map((value) => `  - ${value}`));
  }

  const attachments = asArray(card.attachments);
  if (attachments.length) {
    metadata.push("- Trello attachments:");
    for (const attachment of attachments) {
      const name = escapeMarkdown(attachment.name || attachment.fileName || "Attachment");
      const url = attachment.url || attachment.bytesUrl;
      metadata.push(url ? `  - [${name}](${url})` : `  - ${name}`);
    }
  }

  if (card.closed) metadata.push("- Trello state: archived card");
  metadata.push(`- Trello source ID: ${card.id ?? "unknown"}`);
  if (board.id) metadata.push(`- Trello board ID: ${board.id}`);

  sections.push(`### Imported Trello metadata\n${metadata.join("\n")}`);
  return sections.join("\n\n");
}

function commentText(action) {
  const author =
    action?.memberCreator?.fullName ||
    action?.memberCreator?.username ||
    "Unknown Trello user";
  const date = asString(action?.date, "unknown date");
  const text = asString(action?.data?.text).trim();
  return `Imported Trello comment by ${author} (${date})\n\n${text}`;
}

export function normalizeBoard(rawBoard, options = {}) {
  const includeArchived = options.includeArchived === true;
  const memberById = new Map(
    asArray(rawBoard.members).map((member) => [member.id, member]),
  );
  const customFieldById = new Map(
    asArray(rawBoard.customFields).map((field) => [field.id, field]),
  );

  const allLists = [...asArray(rawBoard.lists)].sort(byPosition);
  const lists = allLists
    .filter((list) => includeArchived || !list.closed)
    .map((list) => ({
      sourceId: asString(list.id),
      name: truncate(
        `${list.closed ? "[Archived] " : ""}${asString(list.name, "Untitled list")}`,
        255,
      ),
      closed: Boolean(list.closed),
      cards: [],
    }));
  const listById = new Map(lists.map((list) => [list.sourceId, list]));

  const labelSource = new Map();
  for (const label of asArray(rawBoard.labels)) labelSource.set(labelKey(label), label);
  for (const card of asArray(rawBoard.cards)) {
    for (const label of asArray(card.labels)) labelSource.set(labelKey(label), label);
  }

  const duplicateLabelNames = new Map();
  const labels = [...labelSource.entries()].map(([sourceId, label]) => {
    const baseName = asString(label.name).trim() || `Trello ${label.color ?? "uncoloured"} label`;
    const count = (duplicateLabelNames.get(baseName) ?? 0) + 1;
    duplicateLabelNames.set(baseName, count);
    return {
      sourceId,
      name: truncate(count === 1 ? baseName : `${baseName} (${count})`, 255),
      colourCode: labelColour(label.color),
    };
  });

  const checklistByCard = new Map();
  for (const checklist of asArray(rawBoard.checklists)) {
    const cardId = asString(checklist.idCard);
    const current = checklistByCard.get(cardId) ?? [];
    current.push(checklist);
    checklistByCard.set(cardId, current);
  }

  const commentsByCard = new Map();
  for (const action of asArray(rawBoard.actions)) {
    if (action?.type !== "commentCard" || !action?.data?.card?.id) continue;
    const current = commentsByCard.get(action.data.card.id) ?? [];
    current.push(action);
    commentsByCard.set(action.data.card.id, current);
  }

  let skippedCards = 0;
  for (const card of [...asArray(rawBoard.cards)].sort(byPosition)) {
    if (!includeArchived && card.closed) {
      skippedCards += 1;
      continue;
    }
    const list = listById.get(asString(card.idList));
    if (!list) {
      skippedCards += 1;
      continue;
    }

    const embeddedChecklists = asArray(card.checklists).filter(
      (checklist) => checklist !== null && typeof checklist === "object",
    );
    const checklists = (embeddedChecklists.length
      ? embeddedChecklists
      : checklistByCard.get(card.id) ?? []
    )
      .sort(byPosition)
      .map((checklist) => ({
        sourceId: asString(checklist.id),
        name: truncate(asString(checklist.name, "Checklist"), 255),
        items: [...asArray(checklist.checkItems)].sort(byPosition).map((item) => ({
          title: truncate(asString(item.name, "Checklist item"), 500),
          completed: item.state === "complete",
        })),
      }));

    const dueDate = card.due && !Number.isNaN(Date.parse(card.due))
      ? new Date(card.due).toISOString()
      : null;

    list.cards.push({
      sourceId: asString(card.id),
      title: truncate(
        `${card.closed ? "[Archived] " : ""}${asString(card.name, "Untitled card")}`,
        2000,
      ),
      description: cardDescription(card, rawBoard, memberById, customFieldById),
      dueDate,
      labelSourceIds: [
        ...asArray(card.labels).map(labelKey),
        ...asArray(card.idLabels).filter((id) => typeof id === "string"),
      ],
      checklists,
      comments: [...(commentsByCard.get(card.id) ?? [])]
        .sort((a, b) => Date.parse(a.date ?? 0) - Date.parse(b.date ?? 0))
        .map((action) => ({
          text: commentText(action),
          createdAt:
            action.date && !Number.isNaN(Date.parse(action.date))
              ? new Date(action.date).toISOString()
              : null,
        })),
      attachmentCount: asArray(card.attachments).length,
      memberCount: asArray(card.idMembers).length,
      customFieldCount: asArray(card.customFieldItems).length,
    });
  }

  const shortIdentifier = slugPart(rawBoard.shortLink || rawBoard.id || rawBoard.name) || generateUID();
  return {
    sourceId: asString(rawBoard.id),
    sourceFile: options.sourceFile,
    name: truncate(asString(rawBoard.name, "Imported Trello board"), 255),
    slug: `trello-${shortIdentifier}`,
    description: [
      asString(rawBoard.desc).trim(),
      `Imported offline from Trello.\n\n[trello-board-id:${asString(rawBoard.id, "unknown")}]`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    labels,
    lists,
    stats: {
      lists: lists.length,
      cards: lists.reduce((total, list) => total + list.cards.length, 0),
      checklists: lists.reduce(
        (total, list) =>
          total + list.cards.reduce((cardTotal, card) => cardTotal + card.checklists.length, 0),
        0,
      ),
      comments: lists.reduce(
        (total, list) =>
          total + list.cards.reduce((cardTotal, card) => cardTotal + card.comments.length, 0),
        0,
      ),
      attachmentsReferenced: lists.reduce(
        (total, list) =>
          total + list.cards.reduce((cardTotal, card) => cardTotal + card.attachmentCount, 0),
        0,
      ),
      skippedLists: allLists.length - lists.length,
      skippedCards,
    },
  };
}

function parseArguments(argv) {
  const options = {
    includeArchived: false,
    allowDuplicates: false,
    dryRun: false,
    scanOnly: false,
    boardFilters: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--include-archived") options.includeArchived = true;
    else if (argument === "--allow-duplicates") options.allowDuplicates = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--scan-only") options.scanOnly = true;
    else if (["--source", "--user-email", "--workspace", "--board"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
      index += 1;
      if (argument === "--source") options.source = value;
      else if (argument === "--user-email") options.userEmail = value;
      else if (argument === "--workspace") options.workspace = value;
      else options.boardFilters.push(value.toLowerCase());
    } else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function printUsage() {
  console.log(`Usage:
  node import-trello-export.mjs --source PATH --scan-only [--include-archived]
  node import-trello-export.mjs --source PATH --user-email EMAIL --workspace SLUG [options]

Options:
  --dry-run              Validate destination and show the import plan without writing
  --scan-only            Scan export files without connecting to PostgreSQL
  --board TEXT           Import board names containing TEXT; may be repeated
  --include-archived     Import archived lists/cards with an [Archived] prefix
  --allow-duplicates     Import even when the deterministic Trello board slug exists
  --help                 Show this help`);
}

function printPlan(board) {
  const stats = board.stats;
  console.log(
    `- ${board.name}: ${stats.lists} lists, ${stats.cards} cards, ` +
      `${stats.checklists} checklists, ${stats.comments} comments, ` +
      `${stats.attachmentsReferenced} attachment references` +
      (stats.skippedLists || stats.skippedCards
        ? ` (${stats.skippedLists} lists and ${stats.skippedCards} cards skipped)`
        : ""),
  );
}

const REQUIRED_KAN_TABLES = [
  'public."user"',
  'public."workspace"',
  'public."workspace_members"',
  'public."import"',
  'public."board"',
  'public."label"',
  'public."list"',
  'public."card"',
  'public."card_activity"',
  'public."_card_labels"',
  'public."card_checklist"',
  'public."card_checklist_item"',
  'public."card_comments"',
];

export async function assertDatabaseSchema(client) {
  const result = await client.query(
    `SELECT current_database() AS "databaseName",
            current_schema() AS "schemaName",
            ARRAY(
              SELECT name
                FROM unnest($1::text[]) AS required(name)
               WHERE to_regclass(name) IS NULL
            ) AS "missingTables"`,
    [REQUIRED_KAN_TABLES],
  );
  const status = result.rows[0];
  const missingTables = asArray(status?.missingTables);
  if (missingTables.length > 0) {
    throw new Error(
      `Kan schema is incomplete in database "${asString(status?.databaseName, "unknown")}" ` +
        `(current schema "${asString(status?.schemaName, "unknown")}"); missing relations: ` +
        `${missingTables.join(", ")}. Run "docker compose run --rm migrate" and retry.`,
    );
  }
}

async function resolveDestination(client, email, workspaceSelector) {
  const result = await client.query(
    `SELECT u.id AS "userId", u.email,
            w.id AS "workspaceId", w."publicId" AS "workspacePublicId",
            w.slug AS "workspaceSlug", w.name AS "workspaceName",
            wm.role, wm.status
       FROM "user" u
       JOIN workspace_members wm ON wm."userId" = u.id
       JOIN workspace w ON w.id = wm."workspaceId"
      WHERE lower(u.email) = lower($1)
        AND w."deletedAt" IS NULL
        AND wm."deletedAt" IS NULL
        AND wm.status = 'active'
        AND (w."publicId" = $2 OR w.slug = $2 OR lower(w.name) = lower($2))
      ORDER BY CASE WHEN w."publicId" = $2 THEN 0 WHEN w.slug = $2 THEN 1 ELSE 2 END
      LIMIT 2`,
    [email, workspaceSelector],
  );

  if (result.rows.length === 0) {
    throw new Error(`No active workspace membership found for ${email} in ${workspaceSelector}`);
  }
  if (result.rows.length > 1) {
    throw new Error(`Workspace selector is ambiguous: ${workspaceSelector}`);
  }
  if (result.rows[0].role === "guest") {
    throw new Error("The selected user is a guest and cannot own imported boards");
  }
  return result.rows[0];
}

async function boardSlugExists(client, workspaceId, slug) {
  const result = await client.query(
    `SELECT id, name FROM board
      WHERE "workspaceId" = $1 AND slug = $2 AND "deletedAt" IS NULL
      LIMIT 1`,
    [workspaceId, slug],
  );
  return result.rows[0] ?? null;
}

async function importBoard(client, board, destination, options) {
  let boardSlug = board.slug;
  const existing = await boardSlugExists(client, destination.workspaceId, boardSlug);
  if (existing && !options.allowDuplicates) {
    console.log(`SKIP ${board.name}: already imported as ${existing.name} (${boardSlug})`);
    return { status: "skipped" };
  }
  if (existing) boardSlug = `${boardSlug}-${generateUID().slice(0, 6)}`;

  if (options.dryRun) {
    console.log(`DRY RUN ${board.name} -> ${destination.workspaceName} (${boardSlug})`);
    return { status: "planned" };
  }

  await client.query("BEGIN");
  try {
    const importResult = await client.query(
      `INSERT INTO "import" ("publicId", source, status, "createdBy")
       VALUES ($1, 'trello', 'started', $2)
       RETURNING id`,
      [generateUID(), destination.userId],
    );
    const importId = importResult.rows[0].id;

    const boardResult = await client.query(
      `INSERT INTO board
        ("publicId", name, description, slug, "createdBy", "importId", "workspaceId", visibility)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'private')
       RETURNING id`,
      [
        generateUID(),
        board.name,
        board.description,
        boardSlug,
        destination.userId,
        importId,
        destination.workspaceId,
      ],
    );
    const boardId = boardResult.rows[0].id;

    const labelIds = new Map();
    for (const label of board.labels) {
      const result = await client.query(
        `INSERT INTO label
          ("publicId", name, "colourCode", "createdBy", "boardId", "importId")
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [generateUID(), label.name, label.colourCode, destination.userId, boardId, importId],
      );
      labelIds.set(label.sourceId, result.rows[0].id);
    }

    const cardCount = board.stats.cards;
    let nextCardNumber = 0;
    if (cardCount > 0) {
      const result = await client.query(
        `UPDATE workspace
            SET "cardCounter" = "cardCounter" + $1
          WHERE id = $2
          RETURNING "cardCounter"`,
        [cardCount, destination.workspaceId],
      );
      nextCardNumber = Number(result.rows[0].cardCounter) - cardCount + 1;
    }

    for (let listIndex = 0; listIndex < board.lists.length; listIndex += 1) {
      const list = board.lists[listIndex];
      const listResult = await client.query(
        `INSERT INTO list
          ("publicId", name, index, "createdBy", "boardId", "importId")
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [generateUID(), list.name, listIndex, destination.userId, boardId, importId],
      );
      const listId = listResult.rows[0].id;

      for (let cardIndex = 0; cardIndex < list.cards.length; cardIndex += 1) {
        const card = list.cards[cardIndex];
        const cardResult = await client.query(
          `INSERT INTO card
            ("publicId", title, description, index, "cardNumber", "createdBy", "listId", "importId", "dueDate")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            generateUID(),
            card.title,
            card.description,
            cardIndex,
            nextCardNumber,
            destination.userId,
            listId,
            importId,
            card.dueDate,
          ],
        );
        nextCardNumber += 1;
        const cardId = cardResult.rows[0].id;

        await client.query(
          `INSERT INTO card_activity ("publicId", type, "cardId", "createdBy")
           VALUES ($1, 'card.created', $2, $3)`,
          [generateUID(), cardId, destination.userId],
        );

        for (const sourceLabelId of card.labelSourceIds) {
          const labelId = labelIds.get(sourceLabelId);
          if (!labelId) continue;
          await client.query(
            `INSERT INTO _card_labels ("cardId", "labelId")
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [cardId, labelId],
          );
        }

        for (let checklistIndex = 0; checklistIndex < card.checklists.length; checklistIndex += 1) {
          const checklist = card.checklists[checklistIndex];
          const checklistResult = await client.query(
            `INSERT INTO card_checklist
              ("publicId", name, index, "cardId", "createdBy")
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [generateUID(), checklist.name, checklistIndex, cardId, destination.userId],
          );
          const checklistId = checklistResult.rows[0].id;

          for (let itemIndex = 0; itemIndex < checklist.items.length; itemIndex += 1) {
            const item = checklist.items[itemIndex];
            await client.query(
              `INSERT INTO card_checklist_item
                ("publicId", title, completed, index, "checklistId", "createdBy")
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [generateUID(), item.title, item.completed, itemIndex, checklistId, destination.userId],
            );
          }
        }

        for (const comment of card.comments) {
          await client.query(
            `INSERT INTO card_comments
              ("publicId", comment, "cardId", "createdBy", "createdAt")
             VALUES ($1, $2, $3, $4, COALESCE($5::timestamp, now()))`,
            [generateUID(), comment.text, cardId, destination.userId, comment.createdAt],
          );
        }
      }
    }

    await client.query(`UPDATE "import" SET status = 'success' WHERE id = $1`, [importId]);
    await client.query("COMMIT");
    console.log(`IMPORTED ${board.name} -> ${destination.workspaceName}`);
    return { status: "imported" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    printUsage();
    return;
  }
  if (!options.source) throw new Error("--source is required");
  if (!options.scanOnly && (!options.userEmail || !options.workspace)) {
    throw new Error("--user-email and --workspace are required unless --scan-only is used");
  }

  const scan = await scanExport(options.source);
  if (scan.parseErrors.length) {
    console.warn(`Warning: ${scan.parseErrors.length} JSON file(s) could not be parsed:`);
    for (const failure of scan.parseErrors) console.warn(`  ${failure.file}: ${failure.error}`);
    throw new Error("Fix or remove malformed JSON files before importing");
  }
  console.log(
    `Scanned ${scan.jsonFileCount} JSON and ${scan.csvFileCount} CSV files; ` +
      `found ${scan.boards.length} Trello board payload(s).`,
  );
  if (scan.csvFileCount > 0) {
    console.log("CSV files are ignored because the JSON files preserve nested Trello data.");
  }
  if (scan.boards.length === 0) throw new Error("No Trello board JSON payloads were found");

  let boards = scan.boards.map(({ board, sourceFile }) =>
    normalizeBoard(board, { includeArchived: options.includeArchived, sourceFile }),
  );
  if (options.boardFilters.length) {
    boards = boards.filter((board) =>
      options.boardFilters.some((filter) => board.name.toLowerCase().includes(filter)),
    );
  }
  if (boards.length === 0) throw new Error("No boards matched the supplied --board filters");
  boards.forEach(printPlan);
  if (options.scanOnly) return;

  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("POSTGRES_URL is required");
  const { Client } = await import("pg");
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await assertDatabaseSchema(client);
    const destination = await resolveDestination(client, options.userEmail, options.workspace);
    console.log(
      `Destination: ${destination.workspaceName} (${destination.workspaceSlug}); ` +
        `owner ${destination.email}; mode ${options.dryRun ? "dry-run" : "import"}`,
    );
    const results = [];
    for (const board of boards) results.push(await importBoard(client, board, destination, options));
    const counts = results.reduce((summary, result) => {
      summary[result.status] = (summary[result.status] ?? 0) + 1;
      return summary;
    }, {});
    console.log(`Complete: ${JSON.stringify(counts)}`);
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
