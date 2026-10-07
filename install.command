#!/bin/sh
TASK_SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec sh "$TASK_SOURCE/scripts/install/install.sh" "$@"
