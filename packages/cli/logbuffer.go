package main

import "sync"

type LogBuffer struct {
	mu       sync.RWMutex
	lines    []string
	capacity int
	total    int
}

func NewLogBuffer(capacity int) *LogBuffer {
	if capacity < 1 {
		capacity = 1
	}
	return &LogBuffer{
		lines:    make([]string, 0, capacity),
		capacity: capacity,
	}
}

func (b *LogBuffer) Append(line string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.lines) < b.capacity {
		b.lines = append(b.lines, line)
	} else {
		b.lines[b.total%b.capacity] = line
	}
	b.total++
}

func (b *LogBuffer) Lines() []string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.total <= len(b.lines) {
		return append([]string(nil), b.lines...)
	}
	out := make([]string, len(b.lines))
	start := b.total % b.capacity
	copy(out, b.lines[start:])
	copy(out[len(b.lines)-start:], b.lines[:start])
	return out
}

func (b *LogBuffer) Total() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.total
}

func (b *LogBuffer) Reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.lines = b.lines[:0]
	b.total = 0
}
