// Runs a task for each call, one after another in the order of the calls. Two saves of the same setting sent at
// once can overtake each other on the way to the service, and the one made first would then be the one that
// stays; in a line they cannot. A task that fails does not hold up the next.
export function inOrder(task) {
  let last = Promise.resolve();
  return value => {
    last = last.then(() => task(value)).catch(() => {});
    return last;
  };
}
