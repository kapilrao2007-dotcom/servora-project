// Wraps an async Express route handler so that any rejected promise (e.g. an
// unexpected error inside an `await`) is passed to next(err) instead of
// crashing the process. Without this, a single bad request hitting an edge
// case in an async handler could take the whole server down.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
