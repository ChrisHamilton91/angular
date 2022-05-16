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
  /** The list of records moved within the collection, sorted by current index, ascending */
  private _movedItems = new _LinkedList<_IterableChangeRecord<V>>();
  /**
   * The list of records with identity changes.
   * Unmoved items appear first, then moved items, both are sorted by current index, ascending
   */
  private _identityChanges = new _LinkedList<_IterableChangeRecord<V>>();
  /** Operations performed at each index, if any */
  private _operations: {[key: number]: _Operations|undefined} = {};
  /** Generates an identity for each item */
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
      fn:
          (record: IterableChangeRecord<V>, previousIndex: number|null,
           currentIndex: number|null) => void) {
    let currItemNode: _Node<_IterableChangeRecord<V>>|null = this._currentItems.head;
    let prevItemNode: _Node<_IterableChangeRecord<V>>|null = this._previousItems.head;

    /** The amount the current index has changed due to previous operations */
    let currentOffset: number = 0;

    let index: number = 0;
    while (currItemNode !== null || prevItemNode !== null) {
      const currOps = this._operations[index];
      if (currOps === undefined) continue;
      // Adjust for previous moves
      if (currOps.moveTo !== null && currOps.moveTo < index) currentOffset--;
      if (currOps.moveFrom !== null && currOps.moveFrom < index) currentOffset++;

      // Check if a new item was added to this index
      if (currOps.add) {
        // Guaranteed to be a current item here if there is an add
        fn(currItemNode!.value, null, index);
        currentOffset++;
      }
      // Check if a previous item was removed from this index
      if (currOps.remove) {
        // Guaranteed to be a previous item here if there is a removal
        fn(prevItemNode!.value, index + currentOffset, null);
        currentOffset--;
      }

      // Only consume moves such that items come from / go to indices greater than the current index

      // Check if a previous item was moved to this index
      if (currOps.moveFrom !== null && currOps.moveFrom > index) {
        // Adjust moveFrom to where the item actually is
        // Only need to adjust for operations that have already happened
        let adjustedMoveFrom: number = currOps.moveFrom + currentOffset;
        for (let i = index + 1; i <= currOps.moveFrom; i++) {
          const nextOps = this._operations[i];
          if (nextOps === undefined) continue;
          if (nextOps.moveTo !== null && nextOps.moveTo < index) adjustedMoveFrom--;
          if (nextOps.moveFrom !== null && nextOps.moveFrom < index) adjustedMoveFrom++;
        }
        // No-op if the item is already in the right spot
        if (adjustedMoveFrom !== index) {
          // Guaranteed to be a current item here if there is a move to here
          fn(currItemNode!.value, adjustedMoveFrom, index);
        }
        currentOffset++;
      }

      // Check if a previous item was moved from this index
      if (currOps.moveTo !== null && currOps.moveTo > index) {
        const adjustedMoveFromIndex: number = index + currentOffset;
        // Adjust the moveToIndex such that the item will end up in the correct index
        // Only need to adjust for operations that haven't happened yet
        let adjustedMoveToIndex: number = currOps.moveTo;
        for (let i = index + 1; i < currOps.moveTo; i++) {
          const nextOps = this._operations[i];
          if (nextOps === undefined) continue;
          if (nextOps.add) adjustedMoveToIndex--;
          if (nextOps.remove) adjustedMoveToIndex++;
          if (nextOps.moveTo !== null && nextOps.moveTo > index) adjustedMoveToIndex++;
          if (nextOps.moveFrom !== null && nextOps.moveFrom > index) adjustedMoveToIndex--;
        }
        // No-op if the item is already in the right spot
        if (adjustedMoveFromIndex !== adjustedMoveToIndex) {
          // Guaranteed to be a previous item here if there is a move from here
          fn(prevItemNode!.value, adjustedMoveFromIndex, adjustedMoveToIndex);
        }
        currentOffset--;
      }

      index++;
      if (currItemNode !== null) currItemNode = currItemNode.next;
      if (prevItemNode !== null) prevItemNode = prevItemNode.next;
    }
  }

  forEachPreviousItem(fn: (record: _IterableChangeRecord<V>) => void) {
    let node: _Node<_IterableChangeRecord<V>>|null;
    for (node = this._previousItems.head; node !== null; node = node.next) {
      fn(node.value);
    }
  }

  forEachAddedItem(fn: (record: _IterableChangeRecord<V>) => void) {
    let node: _Node<_IterableChangeRecord<V>>|null;
    for (node = this._addedItems.head; node !== null; node = node.next) {
      fn(node.value);
    }
  }

  forEachMovedItem(fn: (record: _IterableChangeRecord<V>) => void) {
    let node: _Node<_IterableChangeRecord<V>>|null;
    for (node = this._movedItems.head; node !== null; node = node.next) {
      fn(node.value);
    }
  }

  forEachRemovedItem(fn: (record: _IterableChangeRecord<V>) => void) {
    let node: _Node<_IterableChangeRecord<V>>|null;
    for (node = this._removedItems.head; node !== null; node = node.next) {
      fn(node.value);
    }
  }

  forEachIdentityChange(fn: (record: _IterableChangeRecord<V>) => void) {
    let node: _Node<_IterableChangeRecord<V>>|null;
    for (node = this._identityChanges.head; node !== null; node = node.next) {
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
    /** Tracks the order of enqueues to additionsMap so keys can be iterated by index */
    const additionsKeys = new Map<number, any>();
    /** Stores the old records found at a changed index, could be a delete or a move */
    const removalsMap = new _QueueMap<any, _IterableChangeRecord<V>>();
    /** Tracks the order of enqueues to removalsMap so the keys can be iterated by index */
    const removalsKeys = new Map<number, any>();

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
        this._identityChanges.addLast(node.value);
      }
      index++;
    });

    this._length = index;
    this._collection = collection;

    // Truncate if there are trailing nodes that need to be removed
    if (node !== null && node.next !== null) {
      let nextNode: _Node<_IterableChangeRecord<V>>|null;
      if (this._length === 0) {
        this._currentItems.clear();
        nextNode = node;
      } else {
        this._currentItems.tail = node;
        nextNode = node.next;
        node.next = null;
      }
      while (nextNode !== null) {
        nextNode.value.previousIndex = nextNode.value.currentIndex;
        removalsMap.enqueue(nextNode.value.trackById, nextNode.value);
        removalsKeys.set(index++, nextNode.value.trackById);
        nextNode = nextNode.next;
      }
    }

    this._findOperations(additionsMap, additionsKeys, removalsMap, removalsKeys);
    return this._isDirty();
  }

  /**
   * Finds add, remove, and move operations, populating the appropriate instance properties.
   * If an item has been both added and removed, it is considered to be moved.
   *
   * @param additionsMap Items that exist at an index which they did not previously,
   *     mapped to their trackByIds, these could be additions or moves.
   * @param additionsKeys The keys of items that were added to additionsMap, mapped by index that
   *     the item was added to. Keys must have been added in order of index, ascending.
   * @param removalsMap Items that no longer exist at their previous index,
   *     mapped to their trackByIds, these could be removals or moves
   * @param removalsKeys The keys of items that were added to removalsMap, mapped by index that the
   *     item was removed from. Keys must have been added in order of index, ascending.
   */
  private _findOperations(
      additionsMap: _QueueMap<any, _Node<_IterableChangeRecord<V>>>,
      additionsKeys: Map<number, any>, removalsMap: _QueueMap<any, _IterableChangeRecord<V>>,
      removalsKeys: Map<number, any>): void {
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
          this._identityChanges.addLast(removed);
        }
        removalsKeys.delete(previousIndex);
        removed.currentIndex = currentIndex;
        addedNode.value = removed;
        this._movedItems.addLast(removed);
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
  }

  /** Initializes operations if necessary and updates properties */
  private _updateOperations(index: number, newOps: {
    add?: boolean,
    remove?: boolean,
    moveTo?: number,
    moveFrom?: number,
  }) {
    if (this._operations[index] === undefined) this._operations[index] = new _Operations();
    const ops = this._operations[index]!;
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
      this._operations = {};

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

/** Represents operations that occur at an index */
class _Operations {
  add: boolean = false;
  remove: boolean = false;
  moveTo: number|null = null;
  moveFrom: number|null = null;
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
