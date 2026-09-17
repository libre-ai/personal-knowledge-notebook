import { beforeEach, describe, expect, it } from "bun:test";
import {
  type BlockCommand,
  decideBlockCommand,
  getBacklinks,
  getBlock,
  listAllBlocks,
  type NotebookState,
  searchLocalIndex,
} from "./block";

// Narrows an indexed access (array/Map iteration) to its element type. tsconfig
// enables noUncheckedIndexedAccess, so `arr[0]` is `T | undefined`; in these
// tests the element is always present by construction, and a missing one is a
// test-setup bug worth throwing on rather than a silent `undefined`.
function requireDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label} to be defined`);
  return value;
}

describe("Block Domain", () => {
  describe("CreateWorkspace", () => {
    it("should create an empty workspace", () => {
      const cmd: BlockCommand = { type: "CreateWorkspace" };
      const result = decideBlockCommand(null, cmd);

      expect(result.accepted).toBe(true);
      if (result.accepted) {
        expect(result.events).toHaveLength(1);
        expect(requireDefined(result.events[0], "event").type).toBe("WorkspaceCreated");
        expect(result.state.blocks.size).toBe(0);
      }
    });

    it("should reject creating workspace if one already exists", () => {
      const createCmd: BlockCommand = { type: "CreateWorkspace" };
      const result1 = decideBlockCommand(null, createCmd);

      expect(result1.accepted).toBe(true);
      if (result1.accepted) {
        const result2 = decideBlockCommand(result1.state, createCmd);
        expect(result2.accepted).toBe(false);
        if (!result2.accepted) {
          expect(result2.code).toBe("notebook.workspace_locked");
        }
      }
    });
  });

  describe("CreateBlock", () => {
    let initialState: NotebookState;

    beforeEach(() => {
      const result = decideBlockCommand(null, { type: "CreateWorkspace" });
      expect(result.accepted).toBe(true);
      if (result.accepted) {
        initialState = result.state;
      }
    });

    it("should create a simple text block", () => {
      const cmd: BlockCommand = {
        type: "CreateBlock",
        blockType: "paragraph",
        content: "Hello, World!",
      };
      const result = decideBlockCommand(initialState, cmd);

      expect(result.accepted).toBe(true);
      if (result.accepted) {
        expect(result.state.blocks.size).toBe(1);
        const block = requireDefined(Array.from(result.state.blocks.values())[0], "block");
        expect(block.type).toBe("paragraph");
        expect(block.currentRevision.content).toBe("Hello, World!");
        expect(block.currentRevision.revisionNumber).toBe(1);
        expect(block.linkedBlockIds).toHaveLength(0);
      }
    });

    it("should reject empty content", () => {
      const cmd: BlockCommand = {
        type: "CreateBlock",
        blockType: "paragraph",
        content: "   ",
      };
      const result = decideBlockCommand(initialState, cmd);

      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.code).toBe("notebook.content_empty");
      }
    });

    it("should create block with linked references", () => {
      // Create first block
      const cmd1: BlockCommand = {
        type: "CreateBlock",
        blockType: "paragraph",
        content: "First block",
      };
      const result1 = decideBlockCommand(initialState, cmd1);
      expect(result1.accepted).toBe(true);
      if (!result1.accepted) return;

      const blockId = requireDefined(Array.from(result1.state.blocks.keys())[0], "blockId");

      // Create second block linking to first
      const cmd2: BlockCommand = {
        type: "CreateBlock",
        blockType: "paragraph",
        content: "Second block linking to first",
        linkedBlockIds: [blockId],
      };
      const result2 = decideBlockCommand(result1.state, cmd2);

      expect(result2.accepted).toBe(true);
      if (result2.accepted) {
        const secondBlock = Array.from(result2.state.blocks.values()).find(
          (b) => b.currentRevision.content === "Second block linking to first",
        );
        expect(secondBlock?.linkedBlockIds).toContain(blockId);

        // Check backlinks index
        const backlinks = result2.state.backlinksIndex.get(blockId) ?? [];
        expect(backlinks).toHaveLength(1);
      }
    });

    it("should reject link to non-existent block", () => {
      const cmd: BlockCommand = {
        type: "CreateBlock",
        blockType: "paragraph",
        content: "Block with broken link",
        linkedBlockIds: ["nonexistent"],
      };
      const result = decideBlockCommand(initialState, cmd);

      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.code).toBe("notebook.link_target_not_found");
      }
    });
  });

  describe("EditBlock", () => {
    let state: NotebookState;
    let blockId: string;

    beforeEach(() => {
      const createWs = decideBlockCommand(null, { type: "CreateWorkspace" });
      expect(createWs.accepted).toBe(true);
      if (!createWs.accepted) return;

      const createBlk: BlockCommand = {
        type: "CreateBlock",
        blockType: "paragraph",
        content: "Original content",
      };
      const result = decideBlockCommand(createWs.state, createBlk);
      expect(result.accepted).toBe(true);
      if (result.accepted) {
        state = result.state;
        blockId = requireDefined(Array.from(state.blocks.keys())[0], "blockId");
      }
    });

    it("should edit block content and increment revision", () => {
      const cmd: BlockCommand = {
        type: "EditBlock",
        blockId,
        expectedRevision: 1,
        newContent: "Updated content",
      };
      const result = decideBlockCommand(state, cmd);

      expect(result.accepted).toBe(true);
      if (result.accepted) {
        const block = result.state.blocks.get(blockId);
        expect(block?.currentRevision.content).toBe("Updated content");
        expect(block?.currentRevision.revisionNumber).toBe(2);
        expect(block?.allRevisions).toHaveLength(2);
      }
    });

    it("should reject edit with stale revision", () => {
      const cmd: BlockCommand = {
        type: "EditBlock",
        blockId,
        expectedRevision: 999,
        newContent: "Should fail",
      };
      const result = decideBlockCommand(state, cmd);

      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.code).toBe("notebook.revision_stale");
      }
    });

    it("should reject edit of non-existent block", () => {
      const cmd: BlockCommand = {
        type: "EditBlock",
        blockId: "nonexistent",
        expectedRevision: 1,
        newContent: "Should fail",
      };
      const result = decideBlockCommand(state, cmd);

      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.code).toBe("notebook.block_not_found");
      }
    });

    it("should reject empty edit", () => {
      const cmd: BlockCommand = {
        type: "EditBlock",
        blockId,
        expectedRevision: 1,
        newContent: "  \n  ",
      };
      const result = decideBlockCommand(state, cmd);

      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.code).toBe("notebook.content_empty");
      }
    });

    it("should update linked blocks on edit", () => {
      // Create another block first
      const createBlk: BlockCommand = {
        type: "CreateBlock",
        blockType: "paragraph",
        content: "Target block",
      };
      const createResult = decideBlockCommand(state, createBlk);
      expect(createResult.accepted).toBe(true);
      if (!createResult.accepted) return;

      const targetId = Array.from(createResult.state.blocks.keys()).find((id) => id !== blockId);
      expect(targetId).toBeDefined();
      if (!targetId) return;

      // Edit main block to link to target
      const editCmd: BlockCommand = {
        type: "EditBlock",
        blockId,
        expectedRevision: 1,
        newContent: "Now with link",
        linkedBlockIds: [targetId],
      };
      const editResult = decideBlockCommand(createResult.state, editCmd);

      expect(editResult.accepted).toBe(true);
      if (editResult.accepted) {
        const block = editResult.state.blocks.get(blockId);
        expect(block?.linkedBlockIds).toContain(targetId);

        // Check backlinks
        const backlinks = editResult.state.backlinksIndex.get(targetId) ?? [];
        expect(backlinks).toContain(blockId);
      }
    });
  });

  describe("LinkBlocks", () => {
    let state: NotebookState;
    let block1Id: string;
    let block2Id: string;

    beforeEach(() => {
      const createWs = decideBlockCommand(null, { type: "CreateWorkspace" });
      expect(createWs.accepted).toBe(true);
      if (!createWs.accepted) return;

      const create1: BlockCommand = {
        type: "CreateBlock",
        blockType: "paragraph",
        content: "Block 1",
      };
      const result1 = decideBlockCommand(createWs.state, create1);
      expect(result1.accepted).toBe(true);
      if (!result1.accepted) return;

      const create2: BlockCommand = {
        type: "CreateBlock",
        blockType: "paragraph",
        content: "Block 2",
      };
      const result2 = decideBlockCommand(result1.state, create2);
      expect(result2.accepted).toBe(true);
      if (!result2.accepted) return;

      const ids = Array.from(result2.state.blocks.keys());
      block1Id = requireDefined(ids[0], "block1Id");
      block2Id = requireDefined(ids[1], "block2Id");
      state = result2.state;
    });

    it("should link two blocks", () => {
      const cmd: BlockCommand = {
        type: "LinkBlocks",
        sourceBlockId: block1Id,
        targetBlockId: block2Id,
        expectedRevision: 1,
      };
      const result = decideBlockCommand(state, cmd);

      expect(result.accepted).toBe(true);
      if (result.accepted) {
        const block = result.state.blocks.get(block1Id);
        expect(block?.linkedBlockIds).toContain(block2Id);
      }
    });

    it("should reject circular link (self-reference)", () => {
      const cmd: BlockCommand = {
        type: "LinkBlocks",
        sourceBlockId: block1Id,
        targetBlockId: block1Id,
        expectedRevision: 1,
      };
      const result = decideBlockCommand(state, cmd);

      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.code).toBe("notebook.circular_reference");
      }
    });

    it("should be idempotent", () => {
      const cmd: BlockCommand = {
        type: "LinkBlocks",
        sourceBlockId: block1Id,
        targetBlockId: block2Id,
        expectedRevision: 1,
      };
      const result1 = decideBlockCommand(state, cmd);
      expect(result1.accepted).toBe(true);
      if (!result1.accepted) return;

      // Link again
      const result2 = decideBlockCommand(result1.state, cmd);
      expect(result2.accepted).toBe(true);
      if (!result2.accepted) return;

      const block = result2.state.blocks.get(block1Id);
      // Should still have only one link
      expect(block?.linkedBlockIds.filter((id) => id === block2Id)).toHaveLength(1);
    });

    it("should reject link with stale revision", () => {
      const cmd: BlockCommand = {
        type: "LinkBlocks",
        sourceBlockId: block1Id,
        targetBlockId: block2Id,
        expectedRevision: 999,
      };
      const result = decideBlockCommand(state, cmd);

      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.code).toBe("notebook.revision_stale");
      }
    });
  });

  describe("DeleteBlock", () => {
    let state: NotebookState;
    let blockId: string;

    beforeEach(() => {
      const createWs = decideBlockCommand(null, { type: "CreateWorkspace" });
      expect(createWs.accepted).toBe(true);
      if (!createWs.accepted) return;

      const createBlk: BlockCommand = {
        type: "CreateBlock",
        blockType: "paragraph",
        content: "Block to delete",
      };
      const result = decideBlockCommand(createWs.state, createBlk);
      expect(result.accepted).toBe(true);
      if (result.accepted) {
        state = result.state;
        blockId = requireDefined(Array.from(state.blocks.keys())[0], "blockId");
      }
    });

    it("should delete a block", () => {
      const cmd: BlockCommand = {
        type: "DeleteBlock",
        blockId,
        expectedRevision: 1,
      };
      const result = decideBlockCommand(state, cmd);

      expect(result.accepted).toBe(true);
      if (result.accepted) {
        expect(result.state.blocks.size).toBe(0);
      }
    });

    it("should reject deletion with stale revision", () => {
      const cmd: BlockCommand = {
        type: "DeleteBlock",
        blockId,
        expectedRevision: 999,
      };
      const result = decideBlockCommand(state, cmd);

      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.code).toBe("notebook.revision_stale");
      }
    });

    it("should reject deletion of block with backlinks", () => {
      // Create a second block linking to the first
      const createBlk: BlockCommand = {
        type: "CreateBlock",
        blockType: "paragraph",
        content: "Linking block",
        linkedBlockIds: [blockId],
      };
      const createResult = decideBlockCommand(state, createBlk);
      expect(createResult.accepted).toBe(true);
      if (!createResult.accepted) return;

      // Try to delete the first block
      const deleteCmd: BlockCommand = {
        type: "DeleteBlock",
        blockId,
        expectedRevision: 1,
      };
      const deleteResult = decideBlockCommand(createResult.state, deleteCmd);

      expect(deleteResult.accepted).toBe(false);
      if (!deleteResult.accepted) {
        expect(deleteResult.code).toBe("notebook.export_dependency_missing");
      }
    });
  });

  describe("Queries", () => {
    let state: NotebookState;
    let block1Id: string;
    let block2Id: string;

    beforeEach(() => {
      const createWs = decideBlockCommand(null, { type: "CreateWorkspace" });
      expect(createWs.accepted).toBe(true);
      if (!createWs.accepted) return;

      const create1: BlockCommand = {
        type: "CreateBlock",
        blockType: "heading",
        content: "Important Heading",
      };
      const result1 = decideBlockCommand(createWs.state, create1);
      expect(result1.accepted).toBe(true);
      if (!result1.accepted) return;

      block1Id = requireDefined(Array.from(result1.state.blocks.keys())[0], "block1Id");

      const create2: BlockCommand = {
        type: "CreateBlock",
        blockType: "paragraph",
        content: "This is a regular paragraph with some content",
        linkedBlockIds: [block1Id],
      };
      const result2 = decideBlockCommand(result1.state, create2);
      expect(result2.accepted).toBe(true);
      if (!result2.accepted) return;

      const foundBlock2 = Array.from(result2.state.blocks.keys()).find((id) => id !== block1Id);
      if (!foundBlock2) throw new Error("block2Id should be found");
      block2Id = foundBlock2;
      state = result2.state;
    });

    it("should get block by ID", () => {
      const block = getBlock(state, block1Id);
      expect(block).toBeDefined();
      expect(block?.currentRevision.content).toBe("Important Heading");
    });

    it("should return null for non-existent block", () => {
      const block = getBlock(state, "nonexistent");
      expect(block).toBeNull();
    });

    it("should list all blocks", () => {
      const blocks = listAllBlocks(state);
      expect(blocks).toHaveLength(2);
    });

    it("should get backlinks for a block", () => {
      const backlinks = getBacklinks(state, block1Id);
      expect(backlinks).toHaveLength(1);
      expect(backlinks[0]).toBe(block2Id);
    });

    it("should search blocks by full-text match", () => {
      const results = searchLocalIndex(state, "Important");
      expect(results).toHaveLength(1);
      expect(requireDefined(results[0], "result").id).toBe(block1Id);
    });

    it("should search case-insensitively", () => {
      const results = searchLocalIndex(state, "important");
      expect(results).toHaveLength(1);
    });

    it("should search with partial matches", () => {
      const results = searchLocalIndex(state, "paragraph");
      expect(results).toHaveLength(1);
      expect(requireDefined(results[0], "result").id).toBe(block2Id);
    });

    it("should filter search by block type", () => {
      const results = searchLocalIndex(state, "content", {
        blockType: "paragraph",
      });
      expect(results).toHaveLength(1);
      expect(requireDefined(results[0], "result").type).toBe("paragraph");
    });

    it("should return empty results for no match", () => {
      const results = searchLocalIndex(state, "nonexistent");
      expect(results).toHaveLength(0);
    });

    it("should sort results by relevance", () => {
      // Create blocks with different relevance
      const createExact: BlockCommand = {
        type: "CreateBlock",
        blockType: "paragraph",
        content: "search",
      };
      const resultExact = decideBlockCommand(state, createExact);
      expect(resultExact.accepted).toBe(true);
      if (!resultExact.accepted) return;

      const createContains: BlockCommand = {
        type: "CreateBlock",
        blockType: "paragraph",
        content: "This contains search term",
      };
      const resultContains = decideBlockCommand(resultExact.state, createContains);
      expect(resultContains.accepted).toBe(true);
      if (!resultContains.accepted) return;

      const results = searchLocalIndex(resultContains.state, "search");
      // Exact match should come first
      expect(requireDefined(results[0], "result").currentRevision.content).toBe("search");
    });
  });

  describe("DeleteWorkspace", () => {
    it("should delete workspace", () => {
      const createWs = decideBlockCommand(null, { type: "CreateWorkspace" });
      expect(createWs.accepted).toBe(true);
      if (!createWs.accepted) return;

      const deleteWs: BlockCommand = { type: "DeleteWorkspace" };
      const result = decideBlockCommand(createWs.state, deleteWs);

      expect(result.accepted).toBe(true);
      if (result.accepted) {
        expect(requireDefined(result.events[0], "event").type).toBe("WorkspaceDeleted");
      }
    });
  });
});
