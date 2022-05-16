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
  private _previousLength = 0;
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
   * The list of records with identity changes,
   * unmoved items appear first, then moved items, both are sorted by current index, ascending
   */
  private _identityChanges = new _LinkedList<_IterableChangeRecord<V>>();
  /** Operations performed at each index, if any */
  private _operations = new Map<number, _Operations>();
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

    let index = 0;
    // There is guaranteed to be a currItemNode for each index in this loop
    for (; index < this._length; index++, currItemNode = currItemNode!.next) {
      const ops = this._operations.get(index);
      if (ops === undefined) continue;
      const currRecord = currItemNode!.value;
      // Adjust for previous moves
      if (ops.moveTo !== null && ops.moveTo < index) currentOffset--;
      if (ops.moveFrom !== null && ops.moveFrom < index) currentOffset++;

      // Check if a new item was added to this index
      if (ops.add) {
        fn(currRecord, null, index);
        currentOffset++;
      }
      // Check if a previous item was removed from this index
      if (ops.remove) {
        // Guaranteed to be a previous item here if there was a remove from here
        fn(prevItemNode!.value, index + currentOffset, null);
        currentOffset--;
      }

      // Only consume moves such that items will
      // come from / go to indices greater than the current index

      // Check if a previous item was moved to this index
      if (ops.moveFrom !== null && ops.moveFrom > index) {
        // Adjust moveFrom to where the item actually is
        // Only need to adjust for operations that have already happened
        let adjustedMoveFrom: number = ops.moveFrom + currentOffset;
        for (let i = index + 1; i <= ops.moveFrom; i++) {
          const nextOps = this._operations.get(i);
          if (nextOps === undefined) continue;
          if (nextOps.moveTo !== null && nextOps.moveTo < index) adjustedMoveFrom--;
          if (nextOps.moveFrom !== null && nextOps.moveFrom < index) adjustedMoveFrom++;
        }
        // No-op if the item is already in the right spot
        if (adjustedMoveFrom !== index) {
          fn(currRecord, adjustedMoveFrom, index);
        }
        currentOffset++;
      }

      // Check if a previous item was moved from this index
      if (ops.moveTo !== null && ops.moveTo > index) {
        const adjustedMoveFromIndex: number = index + currentOffset;
        // Adjust the moveToIndex such that the item will end up in the correct index
        // Only need to adjust for operations that haven't happened yet
        let adjustedMoveToIndex: number = ops.moveTo;
        for (let i = index + 1; i < ops.moveTo; i++) {
          const nextOps = this._operations.get(i);
          if (nextOps === undefined) continue;
          if (nextOps.add) adjustedMoveToIndex--;
          if (nextOps.remove) adjustedMoveToIndex++;
          if (nextOps.moveTo !== null && nextOps.moveTo > index) adjustedMoveToIndex++;
          if (nextOps.moveFrom !== null && nextOps.moveFrom > index) adjustedMoveToIndex--;
        }
        // No-op if the item is already in the right spot
        if (adjustedMoveFromIndex !== adjustedMoveToIndex) {
          // Guaranteed to be a previous item here if there was move from here
          fn(prevItemNode!.value, adjustedMoveFromIndex, adjustedMoveToIndex);
        }
        currentOffset--;
      }
      if (prevItemNode !== null) prevItemNode = prevItemNode.next;
    }

    // All indices within current collection have been processed, only removals remain
    while (prevItemNode !== null) {
      fn(prevItemNode.value, index + currentOffset, null);
      currentOffset--;
      prevItemNode = prevItemNode.next;
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
    /** Stores the old records found at a changed index, could be a delete or a move */
    const removalsMap = new _QueueMap<any, _IterableChangeRecord<V>>();

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
      }
      // Mismatch
      else if (!Object.is(node.value.trackById, itemTrackBy)) {
        node.value.previousIndex = node.value.currentIndex;
        removalsMap.enqueue(node.value.trackById, node.value);
        node.value = new _IterableChangeRecord<V>(item, itemTrackBy, index);
        additionsMap.enqueue(itemTrackBy, node);
      }
      // trackById matches, but object identity has changed
      else if (!Object.is(node.value.item, item)) {
        node.value.item = item;
        this._updateOperations(index, {identityChange: true});
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
      while (nextNode !== null) {
        nextNode.value.previousIndex = nextNode.value.currentIndex;
        removalsMap.enqueue(nextNode.value.trackById, nextNode.value);
        nextNode = nextNode.next
      }
    }

    this._findChanges(additionsMap, removalsMap);
    return this._isDirty();
  }

  /**
   * Finds changes that occur at each index, then populates lists of changes.
   * If an item has been both added and removed at an index, it is considered to be moved.
   *
   * @param additionsMap Items that exist at an index which they did not previously,
   *     mapped to their trackByIds, these could be additions or moves.
   * @param removalsMap Items that no longer exist at their previous index,
   *     mapped to their trackByIds, these could be removals or moves
   */
  private _findChanges(
      additionsMap: _QueueMap<any, _Node<_IterableChangeRecord<V>>>,
      removalsMap: _QueueMap<any, _IterableChangeRecord<V>>,
      ): void {
    // Dequeue additionsMap and look for moves
    const addKeyIterator: IterableIterator<number> = additionsMap.keys();
    let nextAddKey: IteratorResult<number, any> = addKeyIterator.next();
    while (nextAddKey.done !== true) {
      const addKey: any = nextAddKey.value;
      let addedNode: _Node<_IterableChangeRecord<V>>|null = additionsMap.dequeue(addKey);
      while (addedNode !== null) {
        const removed: _IterableChangeRecord<V>|null = removalsMap.dequeue(addKey);
        // Moved
        if (removed !== null) {
          const previousIndex: number = removed.previousIndex!;
          const currentIndex: number = addedNode.value.currentIndex!;
          // Check for identity change
          if (!Object.is(addedNode.value.item, removed.item)) {
            removed.item = addedNode.value.item;
            this._updateOperations(currentIndex, {identityChange: true});
          }
          removed.currentIndex = currentIndex;
          addedNode.value = removed;
          this._updateOperations(currentIndex, {moveFrom: previousIndex});
          this._updateOperations(previousIndex, {moveTo: currentIndex});
        }
        // Added
        else {
          const added = addedNode.value;
          this._updateOperations(added.currentIndex!, {add: true});
        }
        addedNode = additionsMap.dequeue(addKey);
      }
      nextAddKey = addKeyIterator.next();
    }

    // Dequeue leftovers in removalsMap
    const remKeyIterator: IterableIterator<number> = removalsMap.keys();
    let nextRemKey: IteratorResult<number, any> = remKeyIterator.next();
    while (nextRemKey.done !== true) {
      const remKey: any = nextRemKey.value;
      let removed: _IterableChangeRecord<V>|null = removalsMap.dequeue(remKey);
      while (removed !== null) {
        removed.currentIndex = null;
        this._updateOperations(removed.previousIndex!, {remove: true});
        removed = removalsMap.dequeue(remKey);
      }
      nextRemKey = remKeyIterator.next();
    }

    this._populateLists();
  }

  /** Convenience method for initializing and updating operations */
  private _updateOperations(index: number, newOps: {
    add?: boolean,
    remove?: boolean,
    moveTo?: number,
    moveFrom?: number,
    identityChange?: boolean
  }) {
    if (this._operations.get(index) === undefined) this._operations.set(index, new _Operations());
    const ops = this._operations.get(index)!;
    if (newOps.add !== undefined) ops.add = newOps.add;
    if (newOps.remove !== undefined) ops.remove = newOps.remove;
    if (newOps.moveFrom !== undefined) ops.moveFrom = newOps.moveFrom;
    if (newOps.moveTo !== undefined) ops.moveTo = newOps.moveTo;
    if (newOps.identityChange !== undefined) ops.identityChange = newOps.identityChange;
  }

  /** Populate lists of changes according to operations */
  private _populateLists() {
    const indexIterator: IterableIterator<number> = this._operations.keys();
    let nextIndex: IteratorResult<number, any> = indexIterator.next();
    while (nextIndex.done !== true) {
    }
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
      this._operations.clear();

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
  identityChange: boolean = false;
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

  keys(): IterableIterator<K> {
    return this._map.keys();
  }

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
