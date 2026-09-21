import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertDatabaseSchema,
  discoverBoardPayloads,
  normalizeBoard,
  scanExport,
} from "./import-trello-export.mjs";

const sampleBoard = {
  id: "board-1",
  shortLink: "AbCd1234",
  name: "Operations",
  desc: "Board description",
  lists: [
    { id: "list-b", name: "Done", pos: 2, closed: false },
    { id: "list-a", name: "To do", pos: 1, closed: false },
    { id: "list-c", name: "Old", pos: 3, closed: true },
  ],
  labels: [{ id: "label-1", name: "Urgent", color: "red" }],
  members: [{ id: "member-1", fullName: "Alex Operator" }],
  customFields: [{ id: "field-1", name: "Site", type: "text" }],
  cards: [
    {
      id: "card-1",
      idList: "list-a",
      name: "Inspect generator",
      desc: "Original description",
      pos: 1,
      closed: false,
      due: "2026-10-01T12:00:00.000Z",
      labels: [{ id: "label-1", name: "Urgent", color: "red" }],
      idMembers: ["member-1"],
      attachments: [{ name: "manual.pdf", url: "https://example.invalid/manual.pdf" }],
      customFieldItems: [{ idCustomField: "field-1", value: { text: "North" } }],
    },
    {
      id: "card-2",
      idList: "list-c",
      name: "Archived work",
      pos: 1,
      closed: true,
      labels: [],
    },
  ],
  checklists: [
    {
      id: "checklist-1",
      idCard: "card-1",
      name: "Steps",
      pos: 1,
      checkItems: [
        { id: "item-2", name: "Run", state: "incomplete", pos: 2 },
        { id: "item-1", name: "Check", state: "complete", pos: 1 },
      ],
    },
  ],
  actions: [
    {
      type: "commentCard",
      date: "2026-09-01T10:00:00.000Z",
      data: { card: { id: "card-1" }, text: "Looks good" },
      memberCreator: { fullName: "Alex Operator" },
    },
  ],
};

test("discovers board payloads inside workspace export wrappers", () => {
  const result = discoverBoardPayloads({ exports: { boards: [sampleBoard] } }, "workspace.json");
  assert.equal(result.length, 1);
  assert.equal(result[0].board.name, "Operations");
});

test("recursively scans JSON and reports CSV without parsing it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trello-export-test-"));
  const nested = path.join(directory, "workspace", "json");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "operations.json"), JSON.stringify(sampleBoard));
  await fs.writeFile(path.join(directory, "workspace", "operations.csv"), "Name,List\nCard,Todo\n");

  const scan = await scanExport(directory);
  assert.equal(scan.boards.length, 1);
  assert.equal(scan.jsonFileCount, 1);
  assert.equal(scan.csvFileCount, 1);
  assert.equal(scan.parseErrors.length, 0);
});

test("normalizes active Trello data and preserves rich metadata", () => {
  const board = normalizeBoard(sampleBoard, { sourceFile: "operations.json" });
  assert.equal(board.slug, "trello-abcd1234");
  assert.deepEqual(board.lists.map((list) => list.name), ["To do", "Done"]);
  assert.equal(board.stats.cards, 1);
  assert.equal(board.stats.skippedLists, 1);
  assert.equal(board.stats.skippedCards, 1);
  assert.equal(board.stats.comments, 1);
  assert.equal(board.stats.attachmentsReferenced, 1);
  assert.equal(board.lists[0].cards[0].dueDate, "2026-10-01T12:00:00.000Z");
  assert.match(board.lists[0].cards[0].description, /Alex Operator/);
  assert.match(board.lists[0].cards[0].description, /manual\.pdf/);
  assert.match(board.lists[0].cards[0].description, /Site: North/);
  assert.deepEqual(
    board.lists[0].cards[0].checklists[0].items.map((item) => item.title),
    ["Check", "Run"],
  );
});

test("can include archived Trello lists and cards", () => {
  const board = normalizeBoard(sampleBoard, { includeArchived: true });
  assert.equal(board.stats.cards, 2);
  assert.equal(board.stats.skippedLists, 0);
  assert.ok(board.lists.some((list) => list.name === "[Archived] Old"));
  const archived = board.lists.flatMap((list) => list.cards).find((card) => card.sourceId === "card-2");
  assert.equal(archived.title, "[Archived] Archived work");
});

test("accepts a fully migrated Kan database schema", async () => {
  const client = {
    query: async () => ({
      rows: [{ databaseName: "kan_db", schemaName: "public", missingTables: [] }],
    }),
  };
  await assertDatabaseSchema(client);
});

test("reports the connected database and missing schema relations", async () => {
  const client = {
    query: async () => ({
      rows: [
        {
          databaseName: "kan_db",
          schemaName: "public",
          missingTables: ['public."user"', 'public."workspace"'],
        },
      ],
    }),
  };
  await assert.rejects(
    assertDatabaseSchema(client),
    /database "kan_db".*public\."user".*docker compose run --rm migrate/,
  );
});
