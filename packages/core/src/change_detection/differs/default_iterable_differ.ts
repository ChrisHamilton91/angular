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
  /** The previous list of change records */
  private _previousItems = new _LinkedList<_IterableChangeRecord<V>>();
  /** The current list of change records */
  private _currentItems = new _LinkedList<_IterableChangeRecord<V>>();
  /** The list of records added to the collection, sorted by current index, ascending */
  private _addedItems = new _LinkedList<_IterableChangeRecord<V>>();
  /** The list of records removed from the collection, sorted by previous index, ascending */
  private _removedItems = new _LinkedList<_IterableChangeRecord<V>>();
  /**
   * The list of records moved within the collection, sorted by min(current index, previous index),
   * ascending, and then current index, ascending. (ex. [9->0],[0->3],[2->1],[1->5])
   */
  private _movedItems = new _LinkedList<_IterableChangeRecord<V>>();
  /** The list of records with identity changes, sorted by current index, ascending */
  private _identityChanges = new _LinkedList<_IterableChangeRecord<V>>();
  /** Operations mapped to what index they affect */
  private _operationsAt: {[key: string]: _Operations|undefined} = {};
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
    let addNode: _Node<_IterableChangeRecord<V>>|null = this._addedItems.head;
    let remNode: _Node<_IterableChangeRecord<V>>|null = this._removedItems.head;
    let moveNode: _Node<_IterableChangeRecord<V>>|null = this._movedItems.head;

    /** The amount the current index has changed due to previous operations */
    let indexOffset: number = 0;

    for (let index = 0; index < this._length; index++) {
      // Adjust for previous moves
      const ops = this._operationsAt[index];
      if (ops !== undefined) {
        if (ops.moveTo !== false && ops.moveTo < index) indexOffset--;
        if (ops.moveFrom !== false && ops.moveFrom < index) indexOffset++;
      }
      // Check if there was an addition at this index
      if (addNode && addNode.value.currentIndex === index) {
        fn(addNode.value, null, index);
        indexOffset++;
        addNode = addNode.next;
      }
      // Check if there was a removal at this index
      if (remNode && remNode.value.previousIndex === index) {
        fn(remNode.value, index + indexOffset, null);
        indexOffset--;
        remNode = remNode.next;
      }

      // Note: Since moves are sorted by min(move to index, move from index)
      // items will only come from / go to indices >= the current index

      // Check if an item was moved to this index
      if (moveNode && moveNode.value.currentIndex === index) {
        const moveFromIndex: number = moveNode.value.previousIndex!;
        // Adjust the moveFromIndex to where the item actually is
        // Only need to adjust for operations that have already happened
        let adjustedMoveFromIndex: number = moveFromIndex + indexOffset;
        for (let i = index + 1; i <= moveFromIndex; i++) {
          const ops = this._operationsAt[i];
          if (ops === undefined) continue;
          if (ops.moveTo !== false && ops.moveTo < index) adjustedMoveFromIndex--;
          if (ops.moveFrom !== false && ops.moveFrom < index) adjustedMoveFromIndex++;
        }
        // No-op if the item is already in the right spot
        if (adjustedMoveFromIndex !== index) {
          fn(moveNode.value, adjustedMoveFromIndex, index);
        }
        indexOffset++;
        moveNode = moveNode.next;
      }

      // Check if an item was moved from this index
      if (moveNode && moveNode.value.previousIndex === index) {
        const moveToIndex: number = moveNode.value.currentIndex!;
        const adjustedMoveFromIndex: number = index + indexOffset;
        // Adjust the moveToIndex such that the item will end up in the correct index
        // Only need to adjust for operations that haven't happened yet
        let adjustedMoveToIndex: number = moveToIndex;
        for (let i = index + 1; i < moveToIndex; i++) {
          const ops = this._operationsAt[i];
          if (ops === undefined) continue;
          if (ops.add) adjustedMoveToIndex--;
          if (ops.remove) adjustedMoveToIndex++;
          if (ops.moveTo !== false && ops.moveTo > index) adjustedMoveToIndex++;
          if (ops.moveFrom !== false && ops.moveFrom > index) adjustedMoveToIndex--;
        }
        // No-op if the item is already in the right spot
        if (adjustedMoveFromIndex !== adjustedMoveToIndex) {
          fn(moveNode.value, adjustedMoveFromIndex, adjustedMoveToIndex);
        }
        indexOffset--;
        moveNode = moveNode.next;
      }
    }

    // All indices within current collection have been processed, only removals remain
    while (remNode !== null) {
      const index: number = remNode.value.previousIndex!;
      fn(remNode.value, index + indexOffset, null);
      indexOffset--;
      remNode = remNode.next;
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
    const additionsMap = new _QueueMap<any, _Node<_IterableChangeRecord<V>>>();
    /** Stores the keys of items added to additionsMap, mapped by index that item was added to */
    const additionsKeys = new Map<number, any>();
    /** Stores the old records found at a changed index, could be a delete or a move */
    const removalsMap = new _QueueMap<any, _IterableChangeRecord<V>>();
    /** Stores the keys of items added to removalsMap, mapped by index item was removed from */
    const removalsKeys = new Map<number, any>();
    /** Stores identity changes mapped to their index, for sorting later */
    const identityChangesMap = new Map<number, _IterableChangeRecord<V>>();

    let node: _Node<_IterableChangeRecord<V>>|null = this._currentItems.head;
    let index = 0;

    iterateListLike(collection, (item: V) => {
      if (node !== null && index !== 0) node = node.next;
      const itemTrackBy: any = this._trackByFn(index, item);
      // Adding items to the tail
      if (node === null) {
        const newRecord = new _IterableChangeRecord(item, itemTrackBy, index);
        node = this._currentItems.addLast(newRecord);
        additionsMap.enqueue(itemTrackBy, node);
        additionsKeys.set(index, itemTrackBy);
      }
      // Mismatch
      else if (!Object.is(node.value.trackById, itemTrackBy)) {
        // Old record removed
        node.value.previousIndex = node.value.currentIndex;
        removalsMap.enqueue(node.value.trackById, node.value);
        removalsKeys.set(index, node.value.trackById);
        // New record added
        const newRecord = new _IterableChangeRecord<V>(item, itemTrackBy, index);
        node.value = newRecord;
        additionsMap.enqueue(itemTrackBy, node);
        additionsKeys.set(index, itemTrackBy);
      }
      // trackById matches, but object identity has changed
      else if (!Object.is(node.value.item, item)) {
        node.value.item = item;
        identityChangesMap.set(index, node.value);
      }
      index++;
    });

    this._length = index;
    this._collection = collection;

    // Truncate if there are trailing nodes that need to be removed
    if (node !== null) {
      let nextNode: _Node<_IterableChangeRecord<V>>|null;
      if (this._length === 0) {
        this._currentItems.clear();
        nextNode = node;
      } else {
        this._currentItems.tail = node;
        nextNode = node.next;
        node.next = null;
      }
      for (; nextNode !== null; nextNode = nextNode.next) {
        nextNode.value.previousIndex = nextNode.value.currentIndex;
        removalsMap.enqueue(nextNode.value.trackById, nextNode.value);
        removalsKeys.set(index++, nextNode.value.trackById);
      }
    }

    this._sortChanges(additionsMap, additionsKeys, removalsMap, removalsKeys, identityChangesMap);
    return this._isDirty();
  }

  /**
   * Sorts changed records into the appropriate lists, in the correct order.
   * If an item has been both added and removed, it is considered to be moved.
   *
   * @param additionsMap Items that exist at an index which they did not previously,
   *     mapped to their trackByIds, these could be additions or moves.
   * @param additionsKeys The keys of items that were added to additionsMap,
   *     mapped by index that the item was added to
   * @param removalsMap Items that no longer exist at their previous index,
   *     mapped to their trackByIds, these could be removals or moves
   * @param removalsKeys The keys of items that were added to removalsMap in order,
   *     mapped by index that the item was removed from
   * @param identityChangesMap Items that have the same trackByIds, but different identities,
   *     mapped to their current index
   */
  private _sortChanges(
      additionsMap: _QueueMap<any, _Node<_IterableChangeRecord<V>>>,
      additionsKeys: Map<number, any>, removalsMap: _QueueMap<any, _IterableChangeRecord<V>>,
      removalsKeys: Map<number, any>,
      identityChangesMap: Map<number, _IterableChangeRecord<V>>): void {
    /** Moves mapped by min(current index, previous index) */
    const movesMap = new _QueueMap<number, _IterableChangeRecord<V>>();

    // Dequeue additionsMap and look for moves
    const addIndexIterator: IterableIterator<number> = additionsKeys.keys();
    let nextAddIndex: IteratorResult<number, any> = addIndexIterator.next();
    while (nextAddIndex.done !== true) {
      const addKey: any = additionsKeys.get(nextAddIndex.value);
      const addedNode: _Node<_IterableChangeRecord<V>> = additionsMap.dequeue(addKey)!;
      const removed: _IterableChangeRecord<V>|null = removalsMap.dequeue(addKey);
      // Moved
      if (removed !== null) {
        const previousIndex: number = removed.previousIndex!;
        const currentIndex: number = addedNode.value.currentIndex!;
        // Check for identity change
        if (!Object.is(addedNode.value.item, removed.item)) {
          removed.item = addedNode.value.item;
          identityChangesMap.set(currentIndex, removed);
        }
        removalsKeys.delete(previousIndex);
        removed.currentIndex = currentIndex;
        addedNode.value = removed
        if (previousIndex < currentIndex) {
          movesMap.enqueue(previousIndex, removed);
        }
        else {
          movesMap.enqueue(currentIndex, removed);
        }
        this._updateOperations(currentIndex, {moveFrom: previousIndex});
        this._updateOperations(previousIndex, {moveTo: currentIndex});
      }
      // Added
      else {
        const added = addedNode.value;
        this._addedItems.addLast(added);
        this._updateOperations(added.currentIndex!, {add: true});
      }
      nextAddIndex = addIndexIterator.next();
    }

    // Dequeue leftovers in removalsMap
    const remIndexIterator: IterableIterator<number> = removalsKeys.keys();
    let nextRemIndex: IteratorResult<number, any> = remIndexIterator.next();
    while (nextRemIndex.done !== true) {
      const remKey: any = removalsKeys.get(nextRemIndex.value);
      const removed: _IterableChangeRecord<V> = removalsMap.dequeue(remKey)!;
      removed.currentIndex = null;
      this._removedItems.addLast(removed);
      this._updateOperations(removed.previousIndex!, {remove: true});
      nextRemIndex = remIndexIterator.next();
    }

    // Convert movesMap to sorted list
    for (let i = 0; i < this._length; i++) {
      if (movesMap.isEmpty()) break;
      let move = movesMap.dequeue(i);
      while (move !== null) {
        this._movedItems.addLast(move);
        move = movesMap.dequeue(i);
      }
    }

    // Convert identityChangesMap to sorted list
    for (let i = 0; i < this._length; i++) {
      if (identityChangesMap.size === 0) break;
      let idChange = identityChangesMap.get(i);
      if (idChange !== undefined) {
        this._identityChanges.addLast(idChange);
      }
    }
  }

  private _updateOperations(
      index: number,
      newOps: {add?: boolean, remove?: boolean, moveTo?: number, moveFrom?: number}) {
    if (this._operationsAt[index] === undefined) this._operationsAt[index] = new _Operations();
    const ops = this._operationsAt[index]!;
    if (newOps.add !== undefined) ops.add = newOps.add;
    if (newOps.remove !== undefined) ops.remove = newOps.remove;
    if (newOps.moveFrom !== undefined) ops.moveFrom = newOps.moveFrom;
    if (newOps.moveTo !== undefined) ops.moveTo = newOps.moveTo;
  }


  /** If there are any additions, moves, removals, or identity changes. */
  private _isDirty(): boolean {
    return (
        !this._addedItems.isEmpty() || !this._movedItems.isEmpty() ||
        !this._removedItems.isEmpty() || !this._identityChanges.isEmpty());
  }

  /**
   * Clear all change tracking lists, set previous indices to current indices,
   * populate previous items list
   */
  private _reset() {
    if (this._isDirty()) {
      this._addedItems.clear();
      this._removedItems.clear();
      this._movedItems.clear();
      this._identityChanges.clear();
      this._previousItems.clear();
      this._operationsAt = {};

      for (let node = this._currentItems.head; node != null; node = node.next) {
        node.value.previousIndex = node.value.currentIndex;
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

/** Singly linked node */
class _Node<T> {
  next: _Node<T>|null = null;
  constructor(public value: T) {}
}

/** Singly linked list */
class _LinkedList<T> {
  head: _Node<T>|null = null;
  tail: _Node<T>|null = null;

  addLast(value: T): _Node<T> {
    const node = new _Node(value);
    if (this.tail === null) {
      this.head = this.tail = node;
    } else {
      this.tail.next = node;
      this.tail = node;
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

/** First-in first-out queue */
class _Queue<T> {
  private _head: _Node<T>|null = null;
  private _tail: _Node<T>|null = null;

  enqueue(item: T): void {
    if (this._tail === null) {
      this._head = this._tail = new _Node<T>(item);
    } else {
      const node = new _Node<T>(item);
      this._tail.next = node;
      this._tail = node;
    }
  }

  dequeue(): T|null {
    if (this._head === null) return null;
    const item: T = this._head.value;
    this._head = this._head.next;
    if (this._head === null) this._tail = null;
    return item;
  }

  isEmpty(): boolean {
    return this._head === null;
  }
}

/** Stores duplicate values in a Map by adding them to a queue */
class _QueueMap<K, T> {
  private _map = new Map<K, _Queue<T>>();

  enqueue(key: K, item: T): void {
    let queue: _Queue<T>|undefined = this._map.get(key);
    if (queue === undefined) {
      queue = new _Queue<T>();
      this._map.set(key, queue);
    }
    queue.enqueue(item);
  }

  dequeue(key: K): T|null {
    const queue: _Queue<T>|undefined = this._map.get(key);
    if (queue === undefined) return null;
    const item: T|null = queue.dequeue();
    if (queue.isEmpty()) this._map.delete(key);
    return item;
  }

  isEmpty(): boolean {
    return this._map.size === 0;
  }
}

/** Represents operations that will occur at an index */
class _Operations {
  add: boolean = false;
  remove: boolean = false;
  moveTo: number|false = false;
  moveFrom: number|false = false;
}
