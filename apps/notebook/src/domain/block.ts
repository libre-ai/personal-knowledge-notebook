/**
 * Notebook domain — local-first block model with search and linking.
 *
 * This module defines the core block lifecycle: creation, editing, linking,
 * deletion, and querying. All operations are local and immutable revisions
 * are retained for recovery/undo. No network transmission; purely local
 * IndexedDB persistence.
 *
 * Pattern: Commands are submitted with expected revision; the domain rejects
 * stale revisions. Queries return read-only views; mutations return events
 * and a new state.
 */

export type BlockType =
  | "text"
  | "heading"
  | "paragraph"
  | "bulletList"
  | "numberedList"
  | "codeBlock"
  | "table"
  | "quote";

export type BlockRefusal =
  | "notebook.workspace_locked"
  | "notebook.revision_stale"
  | "notebook.block_not_found"
  | "notebook.invalid_block_type"
  | "notebook.content_empty"
  | "notebook.circular_reference"
  | "notebook.link_target_not_found"
  | "notebook.export_dependency_missing";

export interface BlockRevision {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly contentHash: string;
  readonly editedAt: string;
  readonly content: string;
}

export interface Block {
  readonly id: string;
  readonly type: BlockType;
  readonly currentRevision: BlockRevision;
  readonly allRevisions: readonly BlockRevision[];
  readonly linkedBlockIds: readonly string[];
  readonly createdAt: string;
  readonly createdRevisionId: string;
}

export interface LinkReference {
  readonly sourceBlockId: string;
  readonly targetBlockId: string;
  readonly position: number;
}

export type BlockCommand =
  | {
      readonly type: "CreateWorkspace";
    }
  | {
      readonly type: "CreateBlock";
      readonly blockType: BlockType;
      readonly content: string;
      readonly linkedBlockIds?: readonly string[];
    }
  | {
      readonly type: "EditBlock";
      readonly blockId: string;
      readonly expectedRevision: number;
      readonly newContent: string;
      readonly linkedBlockIds?: readonly string[];
    }
  | {
      readonly type: "LinkBlocks";
      readonly sourceBlockId: string;
      readonly targetBlockId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: "DeleteBlock";
      readonly blockId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: "DeleteWorkspace";
    };

export type BlockEvent =
  | { readonly type: "WorkspaceCreated" }
  | {
      readonly type: "BlockCreated";
      readonly blockId: string;
      readonly blockType: BlockType;
      readonly content: string;
      readonly linkedBlockIds: readonly string[];
      readonly createdAt: string;
    }
  | {
      readonly type: "BlockRevised";
      readonly blockId: string;
      readonly newRevisionNumber: number;
      readonly newContent: string;
      readonly linkedBlockIds: readonly string[];
      readonly editedAt: string;
    }
  | {
      readonly type: "BlockLinked";
      readonly sourceBlockId: string;
      readonly targetBlockId: string;
    }
  | {
      readonly type: "BlockDeleted";
      readonly blockId: string;
    }
  | { readonly type: "WorkspaceDeleted" };

export interface NotebookState {
  readonly blocks: Map<string, Block>;
  readonly linkIndex: Map<string, readonly string[]>;
  readonly backlinksIndex: Map<string, readonly string[]>;
}

/**
 * Domain decision function: pure fold that takes state and command,
 * returns either refusal or accepted outcome with events and new state.
 */
export function decideBlockCommand(
  state: NotebookState | null,
  command: BlockCommand,
):
  | { readonly accepted: false; readonly code: BlockRefusal }
  | {
      readonly accepted: true;
      readonly events: readonly BlockEvent[];
      readonly state: NotebookState;
    } {
  // CreateWorkspace: Initialize empty notebook
  if (command.type === "CreateWorkspace") {
    if (state !== null) {
      return { accepted: false, code: "notebook.workspace_locked" };
    }
    return {
      accepted: true,
      events: [{ type: "WorkspaceCreated" }],
      state: {
        blocks: new Map(),
        linkIndex: new Map(),
        backlinksIndex: new Map(),
      },
    };
  }

  if (state === null) {
    return { accepted: false, code: "notebook.workspace_locked" };
  }

  if (command.type === "CreateBlock") {
    if (!command.content.trim()) {
      return { accepted: false, code: "notebook.content_empty" };
    }

    const blockId = generateBlockId();
    const now = new Date().toISOString();
    const revisionId = generateRevisionId();

    // Validate linked block IDs exist
    if (command.linkedBlockIds) {
      for (const linkedId of command.linkedBlockIds) {
        if (!state.blocks.has(linkedId)) {
          return { accepted: false, code: "notebook.link_target_not_found" };
        }
      }
    }

    const newBlock: Block = {
      id: blockId,
      type: command.blockType,
      currentRevision: {
        revisionId,
        revisionNumber: 1,
        contentHash: computeContentFingerprint(command.content),
        editedAt: now,
        content: command.content,
      },
      allRevisions: [
        {
          revisionId,
          revisionNumber: 1,
          contentHash: computeContentFingerprint(command.content),
          editedAt: now,
          content: command.content,
        },
      ],
      linkedBlockIds: command.linkedBlockIds ?? [],
      createdAt: now,
      createdRevisionId: revisionId,
    };

    const newState: NotebookState = {
      blocks: new Map(state.blocks),
      linkIndex: new Map(state.linkIndex),
      backlinksIndex: new Map(state.backlinksIndex),
    };

    newState.blocks.set(blockId, newBlock);
    newState.linkIndex.set(blockId, command.linkedBlockIds ?? []);

    // Update backlinks index
    for (const targetId of command.linkedBlockIds ?? []) {
      const backlinks = newState.backlinksIndex.get(targetId) ?? [];
      if (!backlinks.includes(blockId)) {
        newState.backlinksIndex.set(targetId, [...backlinks, blockId]);
      }
    }

    return {
      accepted: true,
      events: [
        {
          type: "BlockCreated",
          blockId,
          blockType: command.blockType,
          content: command.content,
          linkedBlockIds: command.linkedBlockIds ?? [],
          createdAt: now,
        },
      ],
      state: newState,
    };
  }

  if (command.type === "EditBlock") {
    const block = state.blocks.get(command.blockId);
    if (!block) {
      return { accepted: false, code: "notebook.block_not_found" };
    }

    if (block.currentRevision.revisionNumber !== command.expectedRevision) {
      return { accepted: false, code: "notebook.revision_stale" };
    }

    if (!command.newContent.trim()) {
      return { accepted: false, code: "notebook.content_empty" };
    }

    // Validate new linked block IDs exist
    if (command.linkedBlockIds) {
      for (const linkedId of command.linkedBlockIds) {
        if (!state.blocks.has(linkedId)) {
          return { accepted: false, code: "notebook.link_target_not_found" };
        }
        // Prevent circular references
        if (linkedId === command.blockId) {
          return { accepted: false, code: "notebook.circular_reference" };
        }
      }
    }

    const now = new Date().toISOString();
    const revisionId = generateRevisionId();
    const newRevisionNumber = block.currentRevision.revisionNumber + 1;
    const newRevision: BlockRevision = {
      revisionId,
      revisionNumber: newRevisionNumber,
      contentHash: computeContentFingerprint(command.newContent),
      editedAt: now,
      content: command.newContent,
    };

    const updatedBlock: Block = {
      ...block,
      currentRevision: newRevision,
      allRevisions: [...block.allRevisions, newRevision],
      linkedBlockIds: command.linkedBlockIds ?? [],
    };

    const newState: NotebookState = {
      blocks: new Map(state.blocks),
      linkIndex: new Map(state.linkIndex),
      backlinksIndex: new Map(state.backlinksIndex),
    };

    newState.blocks.set(command.blockId, updatedBlock);
    newState.linkIndex.set(command.blockId, command.linkedBlockIds ?? []);

    // Update backlinks index: remove old backlinks from this block, add new
    for (const targetId of block.linkedBlockIds) {
      const backlinks = newState.backlinksIndex.get(targetId) ?? [];
      newState.backlinksIndex.set(
        targetId,
        backlinks.filter((id) => id !== command.blockId),
      );
    }
    for (const targetId of command.linkedBlockIds ?? []) {
      const backlinks = newState.backlinksIndex.get(targetId) ?? [];
      if (!backlinks.includes(command.blockId)) {
        newState.backlinksIndex.set(targetId, [...backlinks, command.blockId]);
      }
    }

    return {
      accepted: true,
      events: [
        {
          type: "BlockRevised",
          blockId: command.blockId,
          newRevisionNumber,
          newContent: command.newContent,
          linkedBlockIds: command.linkedBlockIds ?? [],
          editedAt: now,
        },
      ],
      state: newState,
    };
  }

  if (command.type === "LinkBlocks") {
    const sourceBlock = state.blocks.get(command.sourceBlockId);
    const targetBlock = state.blocks.get(command.targetBlockId);

    if (!sourceBlock) {
      return { accepted: false, code: "notebook.block_not_found" };
    }
    if (!targetBlock) {
      return { accepted: false, code: "notebook.link_target_not_found" };
    }

    if (command.sourceBlockId === command.targetBlockId) {
      return { accepted: false, code: "notebook.circular_reference" };
    }

    if (sourceBlock.currentRevision.revisionNumber !== command.expectedRevision) {
      return { accepted: false, code: "notebook.revision_stale" };
    }

    if (sourceBlock.linkedBlockIds.includes(command.targetBlockId)) {
      return {
        accepted: true,
        events: [],
        state,
      };
    }

    const newLinkedIds = [...sourceBlock.linkedBlockIds, command.targetBlockId];
    const updatedBlock: Block = {
      ...sourceBlock,
      linkedBlockIds: newLinkedIds,
    };

    const newState: NotebookState = {
      blocks: new Map(state.blocks),
      linkIndex: new Map(state.linkIndex),
      backlinksIndex: new Map(state.backlinksIndex),
    };

    newState.blocks.set(command.sourceBlockId, updatedBlock);
    newState.linkIndex.set(command.sourceBlockId, newLinkedIds);

    // Update backlinks
    const backlinks = newState.backlinksIndex.get(command.targetBlockId) ?? [];
    if (!backlinks.includes(command.sourceBlockId)) {
      newState.backlinksIndex.set(command.targetBlockId, [...backlinks, command.sourceBlockId]);
    }

    return {
      accepted: true,
      events: [
        {
          type: "BlockLinked",
          sourceBlockId: command.sourceBlockId,
          targetBlockId: command.targetBlockId,
        },
      ],
      state: newState,
    };
  }

  if (command.type === "DeleteBlock") {
    const block = state.blocks.get(command.blockId);
    if (!block) {
      return { accepted: false, code: "notebook.block_not_found" };
    }

    if (block.currentRevision.revisionNumber !== command.expectedRevision) {
      return { accepted: false, code: "notebook.revision_stale" };
    }

    // Check if any other block links to this one (backlinks)
    const backlinks = state.backlinksIndex.get(command.blockId) ?? [];
    if (backlinks.length > 0) {
      return { accepted: false, code: "notebook.export_dependency_missing" };
    }

    const newState: NotebookState = {
      blocks: new Map(state.blocks),
      linkIndex: new Map(state.linkIndex),
      backlinksIndex: new Map(state.backlinksIndex),
    };

    newState.blocks.delete(command.blockId);
    newState.linkIndex.delete(command.blockId);
    newState.backlinksIndex.delete(command.blockId);

    // Remove this block from any forward links
    for (const targetId of block.linkedBlockIds) {
      const backlinks = newState.backlinksIndex.get(targetId) ?? [];
      newState.backlinksIndex.set(
        targetId,
        backlinks.filter((id) => id !== command.blockId),
      );
    }

    return {
      accepted: true,
      events: [
        {
          type: "BlockDeleted",
          blockId: command.blockId,
        },
      ],
      state: newState,
    };
  }

  if (command.type === "DeleteWorkspace") {
    return {
      accepted: true,
      events: [{ type: "WorkspaceDeleted" }],
      state: null as unknown as NotebookState,
    };
  }

  return { accepted: false, code: "notebook.block_not_found" };
}

/**
 * Query: Get a single block by ID.
 */
export function getBlock(state: NotebookState, blockId: string): Block | null {
  return state.blocks.get(blockId) ?? null;
}

/**
 * Query: List all blocks.
 */
export function listAllBlocks(state: NotebookState): readonly Block[] {
  return Array.from(state.blocks.values());
}

/**
 * Query: Get backlinks (blocks that link to this one).
 */
export function getBacklinks(state: NotebookState, blockId: string): readonly string[] {
  return state.backlinksIndex.get(blockId) ?? [];
}

/**
 * Query: Search blocks by full-text match in content.
 * Returns matching blocks sorted by relevance.
 */
export function searchLocalIndex(
  state: NotebookState,
  query: string,
  filters?: {
    readonly blockType?: BlockType;
    readonly createdAfter?: string;
    readonly createdBefore?: string;
  },
): readonly Block[] {
  const lowerQuery = query.toLowerCase();
  const results: Block[] = [];

  for (const block of state.blocks.values()) {
    // Check type filter
    if (filters?.blockType && block.type !== filters.blockType) {
      continue;
    }

    // Check date filters
    if (filters?.createdAfter && block.createdAt < filters.createdAfter) {
      continue;
    }
    if (filters?.createdBefore && block.createdAt > filters.createdBefore) {
      continue;
    }

    // Full-text search: content and type
    const content = block.currentRevision.content.toLowerCase();
    if (content.includes(lowerQuery)) {
      results.push(block);
    }
  }

  // Sort by relevance: exact match first, then contains at position 0, then others
  results.sort((a, b) => {
    const aContent = a.currentRevision.content.toLowerCase();
    const bContent = b.currentRevision.content.toLowerCase();

    const aExact = aContent === lowerQuery ? 0 : 1;
    const bExact = bContent === lowerQuery ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;

    const aStarts = aContent.startsWith(lowerQuery) ? 0 : 1;
    const bStarts = bContent.startsWith(lowerQuery) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;

    // Default: by creation time descending
    return b.createdAt.localeCompare(a.createdAt);
  });

  return results;
}

// Utility: Generate opaque block ID
function generateBlockId(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Fallback for testing
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return `blk_${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

// Utility: Generate opaque revision ID
function generateRevisionId(): string {
  const bytes = new Uint8Array(12);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Fallback for testing
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return `rev_${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

// A deterministic, non-cryptographic content fingerprint used to tag revisions
// for local change-detection. It is deliberately NOT an integrity digest: the
// domain fold is synchronous and runs on-device (the browser), where a real
// content hash (Web Crypto) is async. The value is stored to distinguish
// revisions and is never relied on for security, deduplication or equality; a
// stronger digest can replace it behind this function without touching callers.
function computeContentFingerprint(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `hash_${Math.abs(hash).toString(16).padStart(8, "0")}`;
}
