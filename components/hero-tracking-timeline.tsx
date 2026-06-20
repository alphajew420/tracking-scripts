"use client";

import { motion, useReducedMotion } from "framer-motion";
import { CheckCircle2, Clock3, PackageCheck, Radio, Truck } from "lucide-react";

const events = [
  {
    icon: PackageCheck,
    status: "Registered",
    detail: "Order synced from merchant checkout",
    time: "09:14",
    tone: "complete",
  },
  {
    icon: Radio,
    status: "Carrier event",
    detail: "Arrived at regional facility",
    time: "11:42",
    tone: "complete",
  },
  {
    icon: Truck,
    status: "Out for delivery",
    detail: "Final-mile courier assigned",
    time: "08:07",
    tone: "active",
  },
  {
    icon: Clock3,
    status: "Webhook queued",
    detail: "Customer portal and support desk notified",
    time: "now",
    tone: "pending",
  },
];

export function HeroTrackingTimeline() {
  const reduceMotion = useReducedMotion();

  return (
    <motion.aside
      className="hero-tracking-card"
      aria-label="Live shipment timeline preview"
      initial={reduceMotion ? false : { opacity: 0, y: 28, scale: 0.98 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="hero-tracking-card-top">
        <div>
          <p className="eyebrow">Live timeline</p>
          <strong>TRK-8F21</strong>
        </div>
        <motion.span
          className="hero-live-pill"
          animate={reduceMotion ? undefined : { opacity: [0.68, 1, 0.68] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
        >
          <span /> streaming
        </motion.span>
      </div>

      <div className="hero-route-strip" aria-hidden="true">
        <span>ORD</span>
        <motion.i
          initial={reduceMotion ? false : { scaleX: 0 }}
          animate={reduceMotion ? undefined : { scaleX: 1 }}
          transition={{ delay: 0.35, duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        />
        <span>JFK</span>
        <motion.i
          initial={reduceMotion ? false : { scaleX: 0 }}
          animate={reduceMotion ? undefined : { scaleX: 1 }}
          transition={{ delay: 0.62, duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        />
        <span>Door</span>
      </div>

      <div className="hero-timeline-list">
        {events.map((event, index) => {
          const Icon = event.icon;
          return (
            <motion.div
              className="hero-timeline-row"
              data-tone={event.tone}
              key={event.status}
              initial={reduceMotion ? false : { opacity: 0, x: 22 }}
              animate={reduceMotion ? undefined : { opacity: 1, x: 0 }}
              transition={{ delay: 0.18 + index * 0.13, duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
            >
              <span className="hero-timeline-icon">
                <Icon size={16} />
              </span>
              <span>
                <strong>{event.status}</strong>
                <small>{event.detail}</small>
              </span>
              <time>{event.time}</time>
            </motion.div>
          );
        })}
      </div>

      <motion.div
        className="hero-event-toast"
        initial={reduceMotion ? false : { opacity: 0, y: 14 }}
        animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
        transition={{ delay: 0.86, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <CheckCircle2 size={17} />
        <span>
          <strong>tracking.status_changed</strong>
          pushed to 3 subscribers
        </span>
      </motion.div>
    </motion.aside>
  );
}
