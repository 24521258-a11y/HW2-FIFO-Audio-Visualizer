
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import './App.css'

type TaskStatus =
  | 'waiting'
  | 'processing'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'error'

type AudioTask = {
  id: number
  name: string
  file: File
  status: TaskStatus
  buffer?: AudioBuffer
  error?: string
}

type QueueEntry = {
  id: number
  file: File
  controller: AbortController
}

const statusLabels: Record<TaskStatus, string> = {
  waiting: 'Waiting',
  processing: 'Processing',
  ready: 'Ready',
  playing: 'Playing',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
  error: 'Error',
}

function App() {
  const [tasks, setTasks] = useState<AudioTask[]>([])
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTrack, setCurrentTrack] = useState<number | null>(null)
  const [volume, setVolume] = useState(70)
  const [message, setMessage] = useState(
    'Add audio files to begin.'
  )

  const fileInputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)

  const queueRef = useRef<QueueEntry[]>([])
  const processingRef = useRef(false)
  const mountedRef = useRef(true)
  const nextIdRef = useRef(1)
  const animationRef = useRef<number | null>(null)
  const playbackTokenRef = useRef(0)
  const playbackOffsetRef = useRef(0)
  const playbackStartRef = useRef(0)
  const playingRef = useRef(false)
  const currentTrackRef = useRef<number | null>(null)
  const tasksRef = useRef<AudioTask[]>([])

  function updateTasks(
    updater: (previous: AudioTask[]) => AudioTask[]
  ) {
    const next = updater(tasksRef.current)
    tasksRef.current = next

    if (mountedRef.current) {
      setTasks(next)
    }
  }

  function updateTask(id: number, changes: Partial<AudioTask>) {
    updateTasks(previous =>
      previous.map(task =>
        task.id === id ? { ...task, ...changes } : task
      )
    )
  }

  function getAudioContext() {
    if (!audioContextRef.current) {
      const context = new AudioContext()
      const analyser = context.createAnalyser()
      const gain = context.createGain()

      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.8
      gain.gain.value = volume / 100

      analyser.connect(gain)
      gain.connect(context.destination)

      audioContextRef.current = context
      analyserRef.current = analyser
      gainRef.current = gain
    }

    return audioContextRef.current
  }

  // Only one worker processes the FIFO queue.
  async function processQueue() {
    if (processingRef.current) return

    processingRef.current = true

    try {
      while (queueRef.current.length > 0 && mountedRef.current) {
        const entry = queueRef.current[0]
        if (!entry) break

        if (entry.controller.signal.aborted) {
          queueRef.current.shift()
          continue
        }

        updateTask(entry.id, { status: 'processing' })
        setMessage(`Decoding: ${entry.file.name}`)

        let objectUrl: string | null = null

        try {
          const context = getAudioContext()

          objectUrl = URL.createObjectURL(entry.file)

          const response = await fetch(objectUrl, {
            signal: entry.controller.signal,
          })

          if (!response.ok) {
            throw new Error('Unable to read audio file')
          }

          const arrayBuffer = await response.arrayBuffer()

          if (entry.controller.signal.aborted) {
            throw new DOMException('Cancelled', 'AbortError')
          }

          // decodeAudioData itself cannot be aborted.
          // Check cancellation again after decoding.
          const decoded = await context.decodeAudioData(arrayBuffer)

          if (entry.controller.signal.aborted || !mountedRef.current) {
            continue
          }

          updateTask(entry.id, {
            buffer: decoded,
            status: 'ready',
          })

          setMessage(`Ready: ${entry.file.name}`)
        } catch (error) {
          if (entry.controller.signal.aborted) {
            updateTask(entry.id, { status: 'cancelled' })
          } else {
            updateTask(entry.id, {
              status: 'error',
              error:
                error instanceof Error
                  ? error.message
                  : 'Unknown decoding error',
            })
          }
        } finally {
          if (objectUrl) URL.revokeObjectURL(objectUrl)
          const position = queueRef.current.findIndex(
            item => item.id === entry.id
          )
          if (position !== -1) {
            queueRef.current.splice(position, 1)
          }
        }
      }
    } finally {
      processingRef.current = false
    }
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    if (files.length === 0) return

    const entries: QueueEntry[] = files.map(file => ({
      id: nextIdRef.current++,
      file,
      controller: new AbortController(),
    }))

    updateTasks(previous => [
      ...previous,
      ...entries.map(entry => ({
        id: entry.id,
        name: entry.file.name,
        file: entry.file,
        status: 'waiting' as const,
      })),
    ])

    queueRef.current.push(...entries)

    setMessage(`${entries.length} audio task(s) added to FIFO queue`)

    void processQueue()

    event.target.value = ''
  }

  function cancelTask(id: number) {
    const entry = queueRef.current.find(item => item.id === id)

    if (entry) {
      entry.controller.abort()
      updateTask(id, { status: 'cancelled' })

      if (!processingRef.current) {
        queueRef.current = queueRef.current.filter(
          item => item.id !== id
        )
      }

      setMessage('Task cancelled')
    }
  }

  function stopSource() {
    playbackTokenRef.current++

    const source = sourceRef.current
    sourceRef.current = null

    if (source) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // Source may already have ended.
      }
      source.disconnect()
    }

    playingRef.current = false
    setIsPlaying(false)
  }

  async function playTrack(id: number, resume = false) {
    const task = tasksRef.current.find(item => item.id === id)
    if (!task?.buffer) return

    stopSource()

    const context = getAudioContext()
    await context.resume()

    if (!mountedRef.current) return

    const analyser = analyserRef.current
    if (!analyser) return

    const source = context.createBufferSource()
    source.buffer = task.buffer
    source.connect(analyser)

    const offset =
      resume && currentTrackRef.current === id
        ? playbackOffsetRef.current
        : 0

    const token = ++playbackTokenRef.current

    sourceRef.current = source
    currentTrackRef.current = id
    playbackOffsetRef.current = offset
    playbackStartRef.current = context.currentTime
    playingRef.current = true

    setCurrentTrack(id)
    setIsPlaying(true)

    updateTasks(previous =>
      previous.map(item => ({
        ...item,
        status:
          item.id === id
            ? 'playing'
            : item.status === 'playing' ||
                item.status === 'paused'
              ? 'ready'
              : item.status,
      }))
    )

    source.onended = () => {
      if (token !== playbackTokenRef.current) return

      source.disconnect()
      sourceRef.current = null
      playingRef.current = false
      playbackOffsetRef.current = 0

      setIsPlaying(false)
      updateTask(id, { status: 'completed' })
      setMessage(`Finished: ${task.name}`)
    }

    source.start(0, offset)
    setMessage(`Now playing: ${task.name}`)
  }

  function pauseAudio() {
    const context = audioContextRef.current
    const id = currentTrackRef.current

    if (!context || id === null || !playingRef.current) return

    const elapsed = context.currentTime - playbackStartRef.current
    playbackOffsetRef.current += elapsed

    stopSource()
    updateTask(id, { status: 'paused' })
    setMessage('Playback paused')
  }

  function stopAudio() {
    const id = currentTrackRef.current
    stopSource()

    playbackOffsetRef.current = 0
    currentTrackRef.current = null
    setCurrentTrack(null)

    if (id !== null) {
      updateTask(id, { status: 'ready' })
    }

    setMessage('Playback stopped')
  }

  function clearFinished() {
    updateTasks(previous =>
      previous.filter(task =>
        !['completed', 'cancelled', 'error'].includes(task.status)
      )
    )
  }

  useEffect(() => {
    if (gainRef.current) {
      gainRef.current.gain.value = volume / 100
    }
  }, [volume])

  // Canvas visualization, independent of React state updates.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const draw = () => {
      const width = canvas.width
      const height = canvas.height

      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = '#0b1224'
      ctx.fillRect(0, 0, width, height)

      const analyser = analyserRef.current
      const bars = 64
      const values = new Uint8Array(256)

      if (analyser && playingRef.current) {
        analyser.getByteFrequencyData(values)
      }

      const gap = 3
      const barWidth = (width - gap * (bars - 1)) / bars

      for (let i = 0; i < bars; i++) {
        const value = values[i * 2] ?? 0
        const barHeight = Math.max(3, (value / 255) * height * 0.85)
        const x = i * (barWidth + gap)
        const y = height - barHeight

        const gradient = ctx.createLinearGradient(0, y, 0, height)
        gradient.addColorStop(0, '#a78bfa')
        gradient.addColorStop(0.5, '#38bdf8')
        gradient.addColorStop(1, '#2563eb')

        ctx.fillStyle = gradient
        ctx.fillRect(x, y, barWidth, barHeight)
      }

      animationRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false

      for (const entry of queueRef.current) {
        entry.controller.abort()
      }

      queueRef.current = []

      playbackTokenRef.current++

      if (sourceRef.current) {
        sourceRef.current.onended = null
        try {
          sourceRef.current.stop()
        } catch {
          // Ignore already-stopped source.
        }
        sourceRef.current.disconnect()
        sourceRef.current = null
      }

      if (analyserRef.current) analyserRef.current.disconnect()
      if (gainRef.current) gainRef.current.disconnect()

      const context = audioContextRef.current
      audioContextRef.current = null

      if (context && context.state !== 'closed') {
        void context.close()
      }
    }
  }, [])

  const readyCount = tasks.filter(
    task =>
      task.status === 'ready' ||
      task.status === 'playing' ||
      task.status === 'paused'
  ).length

  const waitingCount = tasks.filter(
    task =>
      task.status === 'waiting' ||
      task.status === 'processing'
  ).length

  return (
    <main className="app-shell">
      <header className="app-header">
        <span className="eyebrow">WEB AUDIO ENGINE / HW2</span>
        <h1>Audio Queue Studio</h1>
        <p>
          Concurrent requests. Sequential FIFO processing.
          Real-time frequency visualization.
        </p>
      </header>

      <section className="dashboard" aria-label="Audio dashboard">
        <article className="stat-card">
          <span>Total Tracks</span>
          <strong>{tasks.length}</strong>
        </article>

        <article className="stat-card">
          <span>Ready Tracks</span>
          <strong>{readyCount}</strong>
        </article>

        <article className="stat-card">
          <span>Queue Pending</span>
          <strong>{waitingCount}</strong>
        </article>
      </section>

      <section className="panel" aria-labelledby="visualizer-title">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">LIVE FREQUENCY ANALYSIS</span>
            <h2 id="visualizer-title">Audio Spectrum</h2>
          </div>
          <span className="live-indicator">
            {isPlaying ? '● LIVE' : '● IDLE'}
          </span>
        </div>

        <canvas
          ref={canvasRef}
          width={960}
          height={280}
          aria-label="Real-time audio frequency spectrum"
          role="img"
        />

        <div className="player-controls">
          <button
            type="button"
            className="secondary-button"
            onClick={stopAudio}
            disabled={currentTrack === null}
          >
            ■ Stop
          </button>

          <button
            type="button"
            onClick={() => {
              if (isPlaying) {
                pauseAudio()
              } else if (currentTrack !== null) {
                void playTrack(currentTrack, true)
              }
            }}
            disabled={currentTrack === null}
          >
            {isPlaying ? 'Ⅱ Pause' : '▶ Resume'}
          </button>

          <label htmlFor="volume">
            Volume: {volume}%
          </label>
          <input
            id="volume"
            type="range"
            min="0"
            max="100"
            value={volume}
            onChange={event =>
              setVolume(Number(event.target.value))
            }
          />
        </div>

        <p className="status-message" role="status">
          {message}
        </p>
      </section>

      <section className="panel" aria-labelledby="queue-title">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">FIRST IN, FIRST OUT</span>
            <h2 id="queue-title">Audio Task Queue</h2>
          </div>

          <div className="header-actions">
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              multiple
              className="visually-hidden"
              aria-label="Choose audio files"
              onChange={handleFiles}
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              + Add Audio Files
            </button>

            <button
              type="button"
              className="secondary-button"
              onClick={clearFinished}
            >
              Clear Finished
            </button>
          </div>
        </div>

        <div className="queue-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Track</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>

            <tbody>
              {tasks.map((task, index) => (
                <tr key={task.id}>
                  <td>{index + 1}</td>
                  <td className="track-name">{task.name}</td>
                  <td>
                    <span
                      className={`status-pill status-${task.status}`}
                    >
                      {statusLabels[task.status]}
                    </span>
                    {task.error && (
                      <small className="error-text">
                        {task.error}
                      </small>
                    )}
                  </td>
                  <td>
                    {task.status === 'waiting' ||
                    task.status === 'processing' ? (
                      <button
                        type="button"
                        className="danger-button"
                        onClick={() => cancelTask(task.id)}
                      >
                        Cancel
                      </button>
                    ) : task.buffer ? (
                      <button
                        type="button"
                        onClick={() => void playTrack(task.id)}
                      >
                        ▶ Play
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}

              {tasks.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty-state">
                    No audio tasks yet. Add multiple MP3 or WAV files
                    to test the FIFO queue.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="app-footer">
        React + TypeScript · Web Audio API · FFT 512 ·
        AbortController · requestAnimationFrame
      </footer>
    </main>
  )
}

export default App
