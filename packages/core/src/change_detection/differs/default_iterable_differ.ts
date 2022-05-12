/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {RuntimeError, RuntimeErrorCode} from '../../errors';
import {isListLikeIterable, iterateListLike} from '../../util/iterable';
import {stringify} from '../../util/stringify';

import {IterableChangeRecord, IterableChanges, IterableDiffer, IterableDifferFactory, NgIterable, TrackByFunction} from './iterable_differs';


export class DefaultIterableDifferFactory implements IterableDifferFactory {
  constructor() {}
  supports(obj: Object|null|undefined): boolean {
    return isListLikeIterable(obj);
  }

  create<V>(trackByFn?: TrackByFunction<V>): DefaultIterableDiffer<V> {
    return new DefaultIterableDiffer<V>(trackByFn);
  }
}

const trackByIdentity = (index: number, item: any) => item;

/**
 * @deprecated v4.0.0 - Should not be part of public API.
 * @publicApi
 */
export class DefaultIterableDiffer<V> implements IterableDiffer<V>, IterableChanges<V> {
  private _length = 0;
  get length() {
    return this._length;
  }
  private _collection: V[]|Iterable<V>|null = null;
  get collection() {
    return this._collection;
  }
  private _previousItems = new _LinkedList<_IterableChangeRecord<V>>();
  private _currentItems = new _LinkedList<_IterableChangeRecord<V>>();
  private _addedItems = new _LinkedList<_IterableChangeRecord<V>>();
  private _movedItems = new _LinkedList<_IterableChangeRecord<V>>();
  private _removedItems = new _LinkedList<_IterableChangeRecord<V>>();
  /** Keeps track of records where custom track by is the same, but item identity has changed */
  private _identityChanges = new _LinkedList<_IterableChangeRecord<V>>();
  private _trackByFn: TrackByFunction<V>;

  constructor(trackByFn?: TrackByFunction<V>) {
    this._trackByFn = trackByFn || trackByIdentity;
  }

  forEachItem(fn: (record: _IterableChangeRecord<V>) => void) {
    for (let node = this._currentItems.head; node !== null; node = node.next) {
      fn(node.value);
    }
  }

  forEachOperation(
      fn: (item: IterableChangeRecord<V>, previousIndex: number|null, currentIndex: number|null) =>
          void) {
    let addNode = this._addedItems.head;
    let remNode = this._removedItems.head;
    let moveNode = this._movedItems.head;
    let index = 0;
    /** The amount the current index has changed due to operations */
    let indexOffset = 0;
    /** Extra offsets caused by moves to / from an index */
    let extraOffsets: (number|undefined)[] = [];

    for (let node = this._currentItems.head; node != null; node = node.next) {
      const extraOffset: number = extraOffsets[index] || 0;
      indexOffset += extraOffset;
      // Check if there was an addition at this index
      if (addNode && addNode.value.currentIndex === index) {
        fn(addNode.value, null, index + indexOffset);
        addNode = addNode.next;
        indexOffset++;
      }
      // Check if there was a removal at this index
      if (remNode && remNode.value.previousIndex === index) {
        fn(remNode.value, index + indexOffset, null);
        indexOffset--;
      }

      // Check if there were moves to or from this index
      // Note: Since moves are sorted by min(move to index, move from index)
      // items will only come from / go to larger indices than the current index
      // This is important as indexOffset only applies to indices >= the current index
      while (moveNode &&
             (moveNode.value.previousIndex === index || moveNode.value.currentIndex === index)) {
        // Moved from this index
        if (moveNode.value.previousIndex === index) {
          const moveToIndex: number = moveNode.value.currentIndex!;
          const adjustedMoveFromIndex = index + indexOffset;
          const adjustedMoveToIndex = moveToIndex + indexOffset;
          // No-op if the item is already in the right spot
          if (adjustedMoveFromIndex !== adjustedMoveToIndex) {
            fn(moveNode.value, index + indexOffset, moveToIndex + indexOffset);
            indexOffset--;
            const extraOffset: number|undefined = extraOffsets[moveToIndex];
            if (extraOffset === undefined)
              extraOffsets[moveToIndex] = 1;
            else
              extraOffsets[moveToIndex] = extraOffset + 1;
          }
        }
        // Moved to this index
        else {
          const moveFromIndex: number = moveNode.value.previousIndex!;
          const adjustedMoveFromIndex = moveFromIndex + indexOffset;
          const adjustedMoveToIndex = index + indexOffset;
          // No-op if the item is already in the right spot
          if (adjustedMoveFromIndex !== adjustedMoveToIndex) {
            fn(moveNode.value, index + indexOffset, moveFromIndex + indexOffset);
            indexOffset++;
            const extraOffset: number|undefined = extraOffsets[moveFromIndex];
            if (extraOffset === undefined)
              extraOffsets[moveFromIndex] = -1;
            else
              extraOffsets[moveFromIndex] = extraOffset - 1;
          }
        }
        moveNode = moveNode.next;
      }
    }
  }

  forEachPreviousItem(fn: (record: _IterableChangeRecord<V>) => void) {
    for (let node = this._previousItems.head; node !== null; node = node.next) {
      fn(node.value);
    }
  }

  forEachAddedItem(fn: (record: _IterableChangeRecord<V>) => void) {
    for (let node = this._addedItems.head; node !== null; node = node.next) {
      fn(node.value);
    }
  }

  forEachMovedItem(fn: (record: _IterableChangeRecord<V>) => void) {
    for (let node = this._movedItems.head; node !== null; node = node.next) {
      fn(node.value);
    }
  }

  forEachRemovedItem(fn: (record: _IterableChangeRecord<V>) => void) {
    for (let node = this._removedItems.head; node !== null; node = node.next) {
      fn(node.value);
    }
  }

  forEachIdentityChange(fn: (record: _IterableChangeRecord<V>) => void) {
    for (let node = this._identityChanges.head; node !== null; node = node.next) {
      fn(node.value);
    }
  }

  diff(collection: NgIterable<V>|null|undefined): DefaultIterableDiffer<V>|null {
    if (collection == null) collection = [];
    if (!isListLikeIterable(collection)) {
      const errorMessage = (typeof ngDevMode === 'undefined' || ngDevMode) ?
          `Error trying to diff '${stringify(collection)}'. Only arrays and iterables are allowed` :
          '';
      throw new RuntimeError(RuntimeErrorCode.INVALID_DIFFER_INPUT, errorMessage);
    }

    if (this.check(collection)) {
      return this;
    } else {
      return null;
    }
  }

  onDestroy() {}

  check(collection: NgIterable<V>): boolean {
    this._reset();

    /** Stores the new records found at a changed index, could be an add or a move */
    const additionsMap = new _QueueMap<_IterableChangeRecord<V>>();
    /** Stores the keys of items added to the additionsMap in order */
    const additionsKeys = new _Queue<any>();
    /** Stores the old records found at a changed index, could be a delete or a move */
    const removalsMap = new _QueueMap<_IterableChangeRecord<V>>();
    /** Stores the keys of items added to the removalsMap in order */
    const removalsKeys = new _Queue<any>();

    let node: _DoubleNode<_IterableChangeRecord<V>>|null = this._currentItems.head;
    let index = 0;

    iterateListLike(collection, (item: V) => {
      const itemTrackBy = this._trackByFn(index, item);
      // Adding items to the tail
      if (node === null) {
        const newRecord = new _IterableChangeRecord(item, itemTrackBy, index);
        node = this._currentItems.addLast(newRecord);
        additionsMap.enqueue(itemTrackBy, newRecord);
        additionsKeys.enqueue(itemTrackBy)
      }
      // Mismatch
      else if (!Object.is(node.value.trackById, itemTrackBy)) {
        const newRecord = new _IterableChangeRecord<V>(item, itemTrackBy, index);
        node = this._currentItems.addLast(newRecord);
        additionsMap.enqueue(itemTrackBy, newRecord);
        additionsKeys.enqueue(itemTrackBy)
        removalsMap.enqueue(node.value.trackById, node.value);
        removalsKeys.enqueue(node.value.trackById)
      }
      // trackById matches, but object identity has changed
      else if (!Object.is(node.value.item, item)) {
        this._identityChanges.addLast(node.value);
      }


      if (node !== null) node = node.next;
      index++;
    });

    this._length = index;
    this._collection = collection;

    // Truncate if there are trailing nodes that need to be removed
    if (node !== null) {
      let nextNode = node.next;
      node.next = null;
      for (; nextNode !== null; nextNode = nextNode.next) {
        removalsMap.enqueue(nextNode.value.trackById, nextNode.value);
      }
    }

    this._sortAddsRemovalsAndMoves(additionsMap, additionsKeys, removalsMap, removalsKeys);
    return this._isDirty();
  }

  /**
   * Adds additions, removals, and moves to their associated lists.
   * An item that has been both added and removed is considered to be moved.
   * Additions are sorted by the index they were added to, ascending.
   * Removals are sorted by the index they were removed from, ascending.
   * Moves are sorted by min(previous index, current index), ascending.
   *    (ex. [3->0],[1->5],[9->1],[4->2])
   *
   * @param additionsMap Items that exist at an index which they did not previously,
   *     mapped to their trackByIds, these could be additions or moves.
   * @param additionsKeys The keys of items that were added to additionsMap,
   *     sorted by index that the item was added to, ascending
   * @param removalsMap Items that no longer exist at their previous index,
   *     mapped to their trackByIds, these could be removals or moves
   * @param removalsKeys The keys of items that were added to removalsMap in order,
   *     sorted by index that the item was removed from, ascending
   *
   * @internal
   */
  private _sortAddsRemovalsAndMoves(
      additionsMap: _QueueMap<_IterableChangeRecord<V>>,
      additionsKeys: _Queue<any>,
      removalsMap: _QueueMap<_IterableChangeRecord<V>>,
      removalsKeys: _Queue<any>,
  ) {
    /** Decides whether the record was moved, added, or removed */
    const sortNext = (key: any, movedList: _Queue<any>) => {
      const added = additionsMap.dequeue(key);
      const removed = removalsMap.dequeue(key);
      // Moved
      if (added !== null && removed !== null) {
        added.previousIndex = removed.currentIndex;
        movedList.enqueue(added);
      }
      // Added
      else if (added !== null) {
        this._addedItems.addLast(added);
      }
      // Removed
      else if (removed !== null) {
        removed.previousIndex = removed.currentIndex;
        removed.currentIndex = null;
        this._removedItems.addLast(removed);
      }
    };

    /** Moves sorted by current index */
    const movesByCurrIndex = new _Queue<_IterableChangeRecord<V>>();
    let addKey = additionsKeys.dequeue();
    while (addKey !== null) {
      sortNext(addKey, movesByCurrIndex);
      addKey = additionsKeys.dequeue();
    }

    /** Moves sorted by previous index */
    const movesByPrevIndex = new _Queue<_IterableChangeRecord<V>>();
    let remKey = removalsKeys.dequeue();
    while (remKey !== null) {
      sortNext(remKey, movesByPrevIndex);
      remKey = removalsKeys.dequeue();
    }

    this._mergeMoves(movesByCurrIndex, movesByPrevIndex);
  }

  /**
   * Merges two queues of records into this._movedItems
   * such that they are sorted by min(current index, previous index), ascending
   *
   * @param movesByCurrIndex A queue of moved records sorted by current index, ascending
   * @param movesByPrevIndex A queue of moved records sorted by previous index, ascending
   *
   * @internal
   */
  private _mergeMoves(
      movesByCurrIndex: _Queue<_IterableChangeRecord<V>>,
      movesByPrevIndex: _Queue<_IterableChangeRecord<V>>) {
    let recordByCurr: _IterableChangeRecord<V>|null = movesByCurrIndex.dequeue();
    let recordByPrev: _IterableChangeRecord<V>|null = movesByPrevIndex.dequeue();
    while (recordByCurr !== null || recordByPrev !== null) {
      // Both queues still have items
      if (recordByCurr !== null && recordByPrev !== null) {
        const indexByCurr: number = recordByCurr.currentIndex!;
        const indexByPrev: number = recordByPrev.previousIndex!;
        if (indexByCurr < indexByPrev) {
          this._movedItems.addLast(recordByCurr);
          recordByCurr = movesByCurrIndex.dequeue();
        } else if (indexByPrev < indexByCurr) {
          this._movedItems.addLast(recordByPrev);
          recordByPrev = movesByPrevIndex.dequeue();
        } else {
          this._movedItems.addLast(recordByCurr);
          this._movedItems.addLast(recordByPrev);
          recordByCurr = movesByCurrIndex.dequeue();
          recordByPrev = movesByPrevIndex.dequeue();
        }
      }
      // Only movesByCurrIndex has items
      else if (recordByCurr !== null) {
        this._movedItems.addLast(recordByCurr);
        recordByCurr = movesByCurrIndex.dequeue();
      }
      // Only movesByPrevIndex has items
      else if (recordByPrev !== null) {
        this._movedItems.addLast(recordByPrev);
        recordByPrev = movesByPrevIndex.dequeue();
      }
    }
  }

  /**
   * If there are any additions, moves, removals, or identity changes.
   *
   * @internal
   */
  _isDirty(): boolean {
    return (
        !this._addedItems.isEmpty() || !this._movedItems.isEmpty() ||
        !this._removedItems.isEmpty() || !this._identityChanges.isEmpty());
  }

  /**
   * Clear all change tracking lists and populate the 'previous items' list
   *
   * @internal
   */
  _reset() {
    if (this._isDirty()) {
      this._addedItems.clear();
      this._removedItems.clear();
      this._movedItems.clear();
      this._identityChanges.clear();
      this._previousItems.clear();

      for (let node = this._currentItems.head; node != null; node = node.next) {
        this._previousItems.addLast(node.value);
      }
    }
  }
}

/** Record of of an item's identity and indices */
class _IterableChangeRecord<V> implements IterableChangeRecord<V> {
  previousIndex: number|null = null;

  constructor(public item: V, public trackById: any, public currentIndex: number|null) {}
}

/** Doubly linked node */
class _DoubleNode<T> {
  next: _DoubleNode<T>|null = null;
  prev: _DoubleNode<T>|null = null;
  constructor(public value: T) {}
}

/** Doubly linked list */
class _LinkedList<T> {
  head: _DoubleNode<T>|null = null;
  tail: _DoubleNode<T>|null = null;

  addLast(value: T): _DoubleNode<T> {
    const node = new _DoubleNode(value);
    if (this.tail === null) {
      this.head = this.tail = node;
    } else {
      node.prev = this.tail;
      this.tail.next = node;
    }
    return node;
  }

  clear() {
    this.head = this.tail = null;
  }

  isEmpty() {
    return this.head === null;
  }
}

/** Singly linked node */
class _SingleNode<T> {
  next: _SingleNode<T>|null = null;
  constructor(public value: T) {}
}

/** First-in first-out queue */
class _Queue<T> {
  private _head: _SingleNode<T>|null = null;
  private _tail: _SingleNode<T>|null = null;

  enqueue(item: T): void {
    if (this._tail === null) {
      this._head = this._tail = new _SingleNode<T>(item);
    } else {
      this._tail.next = new _SingleNode<T>(item);
    }
  }

  dequeue(): T|null {
    if (this._head === null) return null;
    const item = this._head.value;
    this._head = this._head.next;
    if (this._head === null) this._tail = null;
    return item;
  }

  isEmpty(): boolean {
    return this._head === null;
  }
}

/** Stores duplicate values in a Map by adding them to a queue */
class _QueueMap<T> {
  private _map = new Map<any, _Queue<T>>();

  keys(): IterableIterator<any> {
    return this._map.keys();
  }

  enqueue(key: any, item: T) {
    let queue = this._map.get(key);
    if (queue === undefined) {
      queue = new _Queue<T>();
      this._map.set(key, queue);
    }
    queue.enqueue(item);
  }

  dequeue(key: any): T|null {
    const queue = this._map.get(key);
    if (queue === undefined) return null;
    const item = queue.dequeue();
    if (queue.isEmpty()) this._map.delete(key);
    return item;
  }

  isEmpty(key: any): boolean {
    const queue = this._map.get(key);
    return queue === undefined || queue.isEmpty();
  }
}
