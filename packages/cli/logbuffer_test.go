package main

import (
	"reflect"
	"testing"
)

func TestLogBufferKeepsRecentLinesInOrder(t *testing.T) {
	buf := NewLogBuffer(3)
	for _, line := range []string{"one", "two", "three", "four", "five"} {
		buf.Append(line)
	}
	got := buf.Lines()
	want := []string{"three", "four", "five"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Lines() = %#v, want %#v", got, want)
	}
	if buf.Total() != 5 {
		t.Fatalf("Total() = %d, want 5", buf.Total())
	}
}
