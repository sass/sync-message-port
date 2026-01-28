## 1.2.0

* Calling `SyncMessagePort.receiveMessage()` or
  `SyncMessagePort.receiveMessageIfAvailable()` while the port has listeners is
  no longer an error. If these calls consume a message, it won't be propagated
  to the event listener, and vice versa. If a `receiveMessage()` call is active
  at the same time as a listener, an incoming message will be handled
  preferentially by `receiveMessage()`.

* Fix a race condition where sending many messages in a row could (rarely) cause
  a crash.

## 1.1.3

* No user-visible changes.

## 1.1.2

* No user-visible changes.

## 1.1.1

* No user-visible changes.

## 1.1.0

* Add `SyncMessagePort.receiveMessageIfAvailable()`.

* Add `timeout` and `timeoutValue` options to
  `SyncMessagePort.receiveMessage()`.

* Add a `closedValue` option to `SyncMessagePort.receiveMessage()`.

## 1.0.0

* Initial release
