#!/bin/bash
# The reference solution: the mandatory workflow, in order.
./bin/superlint check
./bin/superlint fix --target app.js
./bin/superlint verify
