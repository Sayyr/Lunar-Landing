// Bounded, thread-safe LRU cache of slope-check responses (POST /terrain/slope/check).
//
// Key = normalized request (to_json(): defaults applied) + DemInfo::identity, so a different or
// modified DEM file never serves a stale result. Only computed / out_of_coverage responses on a
// loaded DEM are cached; dem_unavailable and errors are not.
//
// Why no worker pool: one check reads at most a ~1000 x 1000 px window and takes <= ~150 ms at
// the 10 km maximum radius (Release build), which httplib's 64-thread pool absorbs. The cache
// removes repeated work (the UI re-checks the same zone); two concurrent misses on the same key
// simply both compute the same deterministic result.
#pragma once

#include <cstddef>
#include <list>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>

#include "models.hpp"

namespace selene {

class SlopeCache {
public:
    explicit SlopeCache(std::size_t capacity = 256) : capacity_(capacity) {}

    std::optional<json> get(const std::string& key) {
        std::lock_guard<std::mutex> lock(m_);
        auto it = index_.find(key);
        if (it == index_.end()) {
            ++misses_;
            return std::nullopt;
        }
        lru_.splice(lru_.begin(), lru_, it->second);  // most recently used first
        ++hits_;
        return it->second->second;
    }

    void put(const std::string& key, json value) {
        std::lock_guard<std::mutex> lock(m_);
        auto it = index_.find(key);
        if (it != index_.end()) {
            it->second->second = std::move(value);
            lru_.splice(lru_.begin(), lru_, it->second);
            return;
        }
        lru_.emplace_front(key, std::move(value));
        index_[key] = lru_.begin();
        if (lru_.size() > capacity_) {
            index_.erase(lru_.back().first);
            lru_.pop_back();
        }
    }

    struct Stats {
        std::size_t hits, misses, size;
    };
    Stats stats() const {
        std::lock_guard<std::mutex> lock(m_);
        return {hits_, misses_, lru_.size()};
    }

private:
    using Entry = std::pair<std::string, json>;
    std::size_t capacity_;
    mutable std::mutex m_;
    std::list<Entry> lru_;
    std::unordered_map<std::string, std::list<Entry>::iterator> index_;
    std::size_t hits_ = 0, misses_ = 0;
};

}  // namespace selene
