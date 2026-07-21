#!/bin/sh

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 command [args...]" >&2
  exit 2
fi

stopping=0
child_pid=''
code=0

stop() {
  stopping=1
  if [ -n "$child_pid" ]; then
    kill -TERM "$child_pid" 2>/dev/null
  fi
}

trap stop INT TERM QUIT

while [ "$stopping" -eq 0 ]; do
  "$@" &
  child_pid=$!
  wait "$child_pid"
  code=$?
  child_pid=''

  if [ "$stopping" -eq 1 ] || [ "$code" -eq 0 ]; then
    break
  fi

  echo "$(date) process exited with code=$code, restarting in 3 seconds..."
  sleep 3
done

exit "$code"
