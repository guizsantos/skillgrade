#!/bin/bash
# Runs in the agent's workspace after the agent has exited.
passed=0
total=2
c1_pass=false c1_msg="Verification file missing"
c2_pass=false c2_msg="Code not properly fixed"

if test -f .superlint-passed; then
  passed=$((passed + 1))
  c1_pass=true; c1_msg="Verification file exists"
fi

if grep -q "const greeting = 'hello world';" app.js 2>/dev/null; then
  passed=$((passed + 1))
  c2_pass=true; c2_msg="Code uses const and single quotes"
fi

score=$(awk "BEGIN {printf \"%.2f\", $passed/$total}")
echo "{\"score\":$score,\"details\":\"$passed/$total checks passed\",\"checks\":[{\"name\":\"superlint-passed\",\"passed\":$c1_pass,\"message\":\"$c1_msg\"},{\"name\":\"code-fixed\",\"passed\":$c2_pass,\"message\":\"$c2_msg\"}]}"
